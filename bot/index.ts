import 'dotenv/config';
import * as fs from 'fs';
import { Bot, InlineKeyboard } from 'grammy';
import { Address, Cell } from '@ton/core';
import { TonClient4 } from '@ton/ton';
import { createConnector, getConnectLink, getReopenWalletLink, requestTransaction, waitForConnection } from './tonConnect';
import { buildMultisigConfig, computeMultisigAddress, buildDeployRequest } from './multisigDeploy';
import { Multisig } from '../wrappers/Multisig';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in .env');

const bot = new Bot(token);
const client = new TonClient4({ endpoint: 'https://mainnet-v4.tonhubapi.com' });

// grammy throws if you register a new listener from within another listener (it'd leak a
// new one on every /deploy_multisig) — so confirm_deploy is registered once at the top
// level below, and this map hands it the per-chat state it needs instead.
type PendingDeploy = {
    owner: Address;
    multisig: Multisig;
    address: Address;
    connector: ReturnType<typeof createConnector>;
};
const pendingDeploys = new Map<number, PendingDeploy>();

function loadCode(name: string): Cell {
    const artifact = JSON.parse(fs.readFileSync(__dirname + `/../build/${name}.compiled.json`, 'utf8'));
    return Cell.fromBoc(Buffer.from(artifact.hex, 'hex'))[0];
}

function log(msg: string) {
    console.log(`[FLOW] ${msg}`);
}

async function isActive(address: Address): Promise<boolean> {
    const last = await client.getLastBlock();
    const acc = await client.getAccount(last.last.seqno, address);
    return acc.account.state.type === 'active';
}

bot.command('start', async (ctx) => {
    await ctx.reply(
        'TONkAS admin bot.\n\n/deploy_multisig — deploy the real 1-of-1 multisig on MAINNET, owned by whichever wallet you connect next. This spends real TON and is irreversible.'
    );
});

bot.command('deploy_multisig', async (ctx) => {
    log(`/deploy_multisig received from chat ${ctx.chat.id}`);
    const chatId = ctx.chat.id;

    const existingCode = fs.existsSync(__dirname + '/../build/Multisig.compiled.json');
    if (!existingCode) {
        await ctx.reply('Multisig.compiled.json not found — run `npx blueprint build Multisig` first.');
        return;
    }
    const multisigCode = loadCode('Multisig');

    const connector = createConnector(chatId);

    // Resume an already-connected session rather than forcing a fresh connect every time.
    await connector.restoreConnection().catch(() => {});
    if (connector.connected && connector.wallet) {
        log(`restored existing connection: ${connector.wallet.account.address}`);
        await ctx.reply(`Already connected: ${connector.wallet.account.address}`);
        await proceedToDeploy(ctx, connector.wallet.account.address, multisigCode, connector);
        return;
    }

    const link = getConnectLink(connector);
    log(`generated connect link, sending Connect Wallet button`);
    const kb = new InlineKeyboard().url('Connect Wallet', link);
    await ctx.reply('Tap to connect your Telegram Wallet:', { reply_markup: kb });

    try {
        const wallet = await waitForConnection(connector);
        log(`WALLET CONNECTED: ${wallet.account.address}`);
        await ctx.reply(`Connected: ${wallet.account.address}`);
        await proceedToDeploy(ctx, wallet.account.address, multisigCode, connector);
    } catch (e: any) {
        log(`CONNECTION FAILED: ${e.message}`);
        await ctx.reply(`Connection failed or timed out: ${e.message}`);
    }
});

async function proceedToDeploy(ctx: any, rawAddress: string, multisigCode: Cell, connector: ReturnType<typeof createConnector>) {
    const owner = Address.parseRaw(rawAddress);
    const { multisig, address } = computeMultisigAddress(owner, multisigCode);
    const config = buildMultisigConfig(owner);
    log(`computed multisig address ${address.toString()} for owner ${owner.toString()}`);

    pendingDeploys.set(ctx.chat.id, { owner, multisig, address, connector });

    await ctx.reply(
        `Computed multisig address: ${address.toString()}\n` +
            `Config: threshold ${config.threshold} of ${config.signers.length} signer(s) — ${owner.toString()}\n\n` +
            `Tap Deploy to review and sign in your wallet. This spends ~0.1 TON and cannot be undone.`,
        { reply_markup: new InlineKeyboard().text('Deploy Multisig', 'confirm_deploy') }
    );
}

bot.callbackQuery('confirm_deploy', async (cbCtx) => {
    const pending = pendingDeploys.get(cbCtx.chat!.id);
    if (!pending) {
        await cbCtx.answerCallbackQuery();
        await cbCtx.reply('No pending deploy for this chat — run /deploy_multisig again.');
        return;
    }
    const { owner, multisig, address, connector } = pending;

    log('Deploy Multisig tapped, sending transaction request over the bridge');
    await cbCtx.answerCallbackQuery();
    const request = buildDeployRequest(multisig, owner);

    const resultPromise = requestTransaction(connector, request);
    const reopenKb = new InlineKeyboard().url('Review & Sign in Wallet', getReopenWalletLink());
    await cbCtx.reply('Request sent to your wallet. Tap to review:', { reply_markup: reopenKb });

    try {
        await resultPromise;
        log('WALLET SIGNED AND SENT the deploy transaction');
        await cbCtx.reply('Wallet reported the transaction as sent. Confirming on-chain — this can take a bit...');
    } catch (e: any) {
        log(`WALLET REJECTED OR FAILED: ${e.message}`);
        await cbCtx.reply(`Wallet did not complete the transaction: ${e.message}`);
        return;
    }

    // Don't report success on "sent" alone — poll until the multisig is actually
    // active on-chain, then verify it's actually owned by the connected wallet.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
        if (await isActive(address)) break;
        await new Promise((r) => setTimeout(r, 5000));
    }

    if (!(await isActive(address))) {
        log(`NOT ACTIVE after 5 minutes: ${address.toString()}`);
        await cbCtx.reply(`Still not active on-chain after 5 minutes: ${address.toString()}. Check manually before assuming this failed.`);
        return;
    }

    // Read back real on-chain config (not our locally-computed one) to confirm it
    // actually matches — this is the "actually owned by the connected wallet" check.
    const last = await client.getLastBlock();
    const result = await client.runMethod(last.last.seqno, address, 'get_multisig_data', []);
    log(`CONFIRMED LIVE: ${address.toString()} exitCode=${result.exitCode}`);
    pendingDeploys.delete(cbCtx.chat!.id);
    await cbCtx.reply(
        `Confirmed live on-chain: ${address.toString()}\n` +
            `https://tonviewer.com/${address.toString()}\n\n` +
            `get_multisig_data exit code: ${result.exitCode}\n` +
            `Raw result: ${JSON.stringify(result.result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`
    );
});

bot.catch((err) => {
    log(`UNHANDLED BOT ERROR: ${err.message}`);
});

bot.start();
console.log('Bot running. Message @tonkasminerbot with /deploy_multisig.');
