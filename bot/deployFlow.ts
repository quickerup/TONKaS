import { Bot, InlineKeyboard } from 'grammy';
import { Address, TonClient4 } from '@ton/ton';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { createConnector, getConnectLink, getReopenWalletLink, requestTransaction, waitForConnection } from './tonConnect';

// Shared across every mainnet deploy this bot handles (multisig, and now Locker/Registry/
// Vault/SkipCollection/Router) -- connect once per chat if needed, build the deploy
// request, fire it over the bridge, poll real on-chain state until active, then run a
// contract-specific verification read before calling it done. No deploy is reported
// successful on the transaction being sent alone.

export type DeployDescriptor = {
    name: string; // for logging and messages, e.g. "LiquidityLocker"
    address: Address;
    describe: (owner: Address) => string; // shown before the Deploy button, e.g. computed address + config summary
    buildRequest: (owner: Address) => SendTransactionRequest;
    // Runs once the address is confirmed active on-chain. Should itself read real get-method
    // state (not just report "active") and return a human-readable confirmation string, or
    // throw if something doesn't check out.
    verify: (client: TonClient4, address: Address) => Promise<string>;
    spendWarning: string; // e.g. "~0.1 TON" -- shown in the confirm message
};

type Pending = { descriptor: DeployDescriptor; owner: Address; connector: ReturnType<typeof createConnector> };
const pendingByChatCallback = new Map<string, Pending>(); // key: `${chatId}:${callbackData}`

function log(name: string, msg: string) {
    console.log(`[FLOW:${name}] ${msg}`);
}

// One callback handler per bot process, registered once at the top level by whoever calls
// registerDeployCallbacks -- see bot/index.ts. Individual command handlers must NOT
// register their own bot.callbackQuery(...) inside a command handler: grammy explicitly
// throws on that (it would leak a new listener on every invocation) -- hit this for real
// once already deploying the multisig, see that fix's commit.
export function registerDeployCallbacks(bot: Bot, client: TonClient4) {
    bot.on('callback_query:data', async (ctx) => {
        const key = `${ctx.chat!.id}:${ctx.callbackQuery.data}`;
        const pending = pendingByChatCallback.get(key);
        if (!pending) return; // not one of ours (or already consumed) -- let other handlers see it

        const { descriptor, owner, connector } = pending;
        pendingByChatCallback.delete(key);

        log(descriptor.name, 'Deploy tapped, sending transaction request over the bridge');
        await ctx.answerCallbackQuery();
        const request = descriptor.buildRequest(owner);

        const resultPromise = requestTransaction(connector, request);
        const reopenKb = new InlineKeyboard().url('Review & Sign in Wallet', getReopenWalletLink());
        await ctx.reply('Request sent to your wallet. Tap to review:', { reply_markup: reopenKb });

        try {
            await resultPromise;
            log(descriptor.name, 'WALLET SIGNED AND SENT the deploy transaction');
            await ctx.reply('Wallet reported the transaction as sent. Confirming on-chain — this can take a bit...');
        } catch (e: any) {
            log(descriptor.name, `WALLET REJECTED OR FAILED: ${e.message}`);
            await ctx.reply(`Wallet did not complete the transaction: ${e.message}`);
            return;
        }

        const deadline = Date.now() + 5 * 60 * 1000;
        let active = false;
        while (Date.now() < deadline) {
            const last = await client.getLastBlock();
            const acc = await client.getAccount(last.last.seqno, descriptor.address);
            if (acc.account.state.type === 'active') {
                active = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 5000));
        }

        if (!active) {
            log(descriptor.name, 'NOT ACTIVE after 5 minutes');
            await ctx.reply(`Still not active on-chain after 5 minutes: ${descriptor.address.toString()}. Check manually before assuming this failed.`);
            return;
        }

        try {
            const result = await descriptor.verify(client, descriptor.address);
            log(descriptor.name, `CONFIRMED: ${result}`);
            await ctx.reply(`Confirmed live on-chain: ${descriptor.address.toString()}\nhttps://tonviewer.com/${descriptor.address.toString()}\n\n${result}`);
        } catch (e: any) {
            log(descriptor.name, `VERIFY FAILED: ${e.message}`);
            await ctx.reply(`Active on-chain but verification failed: ${e.message}. Check manually before assuming this succeeded correctly.`);
        }
    });
}

export async function startDeployFlow(bot: Bot, ctx: any, descriptor: DeployDescriptor) {
    const chatId = ctx.chat.id;
    const connector = createConnector(chatId);
    await connector.restoreConnection().catch(() => {});

    const proceed = async (rawOwnerAddress: string) => {
        const owner = Address.parseRaw(rawOwnerAddress);
        const callbackData = `confirm_deploy_${descriptor.name}`;
        pendingByChatCallback.set(`${chatId}:${callbackData}`, { descriptor, owner, connector });

        await ctx.reply(
            `${descriptor.describe(owner)}\n\nTap Deploy to review and sign in your wallet. This spends ${descriptor.spendWarning} and cannot be undone.`,
            { reply_markup: new InlineKeyboard().text(`Deploy ${descriptor.name}`, callbackData) }
        );
    };

    if (connector.connected && connector.wallet) {
        log(descriptor.name, `restored existing connection: ${connector.wallet.account.address}`);
        await ctx.reply(`Already connected: ${connector.wallet.account.address}`);
        await proceed(connector.wallet.account.address);
        return;
    }

    const link = getConnectLink(connector);
    const kb = new InlineKeyboard().url('Connect Wallet', link);
    await ctx.reply('Tap to connect your Telegram Wallet:', { reply_markup: kb });

    try {
        const wallet = await waitForConnection(connector);
        log(descriptor.name, `WALLET CONNECTED: ${wallet.account.address}`);
        await ctx.reply(`Connected: ${wallet.account.address}`);
        await proceed(wallet.account.address);
    } catch (e: any) {
        log(descriptor.name, `CONNECTION FAILED: ${e.message}`);
        await ctx.reply(`Connection failed or timed out: ${e.message}`);
    }
}
