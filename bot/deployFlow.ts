import { Bot, InlineKeyboard } from 'grammy';
import { Address, TonClient4 } from '@ton/ton';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { createConnector, getConnectLink, getReopenWalletLink, requestTransaction, waitForConnection, WalletName } from './tonConnect';

// Shared across every mainnet deploy this bot handles (multisig, and now Locker/Registry/
// Vault/SkipCollection/Router) -- connect once per chat if needed, build the deploy
// request, fire it over the bridge, poll real on-chain state until active, then run a
// contract-specific verification read before calling it done. No deploy is reported
// successful on the transaction being sent alone.

export type DeployDescriptor = {
    name: string; // for logging and messages, e.g. "LiquidityLocker"
    address: Address; // the contract address being deployed -- polled for 'active' state
    describe: (owner: Address) => string; // shown before the Deploy button, e.g. computed address + config summary
    buildRequest: (owner: Address) => SendTransactionRequest | Promise<SendTransactionRequest>;
    // Runs once the address is confirmed active on-chain. Should itself read real get-method
    // state (not just report "active") and return a human-readable confirmation string, or
    // throw if something doesn't check out.
    verify: (client: TonClient4, address: Address) => Promise<string>;
    spendWarning: string; // e.g. "~0.1 TON" -- shown in the confirm message
};

type Pending = { descriptor: DeployDescriptor; owner: Address; connector: ReturnType<typeof createConnector>; wallet: WalletName };
const pendingByChatCallback = new Map<string, Pending>(); // key: `${chatId}:${callbackData}`

// Admin actions (SetJettonWallet, SetRouter, unpausing, ...) go through the multisig as a
// new_order rather than a plain deploy -- no address to poll for "active" (the target
// contract already exists), instead poll until a get-method reflects the expected new
// state. Reuses the same connect/bridge/reopen machinery and the same top-level callback
// handler as deploys, just a different descriptor shape and confirmation strategy.
export type AdminActionDescriptor = {
    name: string; // for logging, e.g. "SetJettonWallet"
    describe: (owner: Address) => string;
    buildRequest: (owner: Address) => SendTransactionRequest | Promise<SendTransactionRequest>; // wraps the target call as a multisig new_order
    // Polled every 5s for up to 5 minutes. Should read real get-method state and return a
    // confirmation string once the change has actually landed, or throw/return null to keep
    // polling. Distinguish "not yet landed" (return null) from "landed but wrong" (throw).
    poll: (client: TonClient4) => Promise<string | null>;
    spendWarning: string;
};

type PendingAction = { descriptor: AdminActionDescriptor; owner: Address; connector: ReturnType<typeof createConnector>; wallet: WalletName };
const pendingActionsByChatCallback = new Map<string, PendingAction>();

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

        const pendingAction = pendingActionsByChatCallback.get(key);
        if (pendingAction) {
            pendingActionsByChatCallback.delete(key);
            await runAdminAction(ctx, client, pendingAction);
            return;
        }

        const pending = pendingByChatCallback.get(key);
        if (!pending) return; // not one of ours (or already consumed) -- let other handlers see it

        const { descriptor, owner, connector, wallet } = pending;
        pendingByChatCallback.delete(key);

        log(descriptor.name, 'Deploy tapped, sending transaction request over the bridge');
        await ctx.answerCallbackQuery();
        const request = await descriptor.buildRequest(owner);

        const resultPromise = requestTransaction(connector, request);
        const reopenKb = new InlineKeyboard().url('Review & Sign in Wallet', getReopenWalletLink(wallet));
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

async function runAdminAction(ctx: any, client: TonClient4, pending: PendingAction) {
    const { descriptor, owner, connector, wallet } = pending;

    log(descriptor.name, 'Action tapped, sending order request over the bridge');
    await ctx.answerCallbackQuery();
    const request = await descriptor.buildRequest(owner);

    const resultPromise = requestTransaction(connector, request);
    const reopenKb = new InlineKeyboard().url('Review & Sign in Wallet', getReopenWalletLink(wallet));
    await ctx.reply('Request sent to your wallet. Tap to review:', { reply_markup: reopenKb });

    try {
        await resultPromise;
        log(descriptor.name, 'WALLET SIGNED AND SENT the order');
        await ctx.reply('Wallet reported the transaction as sent. Confirming on-chain — this can take a bit...');
    } catch (e: any) {
        log(descriptor.name, `WALLET REJECTED OR FAILED: ${e.message}`);
        await ctx.reply(`Wallet did not complete the transaction: ${e.message}`);
        return;
    }

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
        try {
            const result = await descriptor.poll(client);
            if (result) {
                log(descriptor.name, `CONFIRMED: ${result}`);
                await ctx.reply(`Confirmed on-chain: ${result}`);
                return;
            }
        } catch (e: any) {
            log(descriptor.name, `VERIFY FAILED: ${e.message}`);
            await ctx.reply(`Landed on-chain but verification failed: ${e.message}. Check manually before assuming this succeeded correctly.`);
            return;
        }
        await new Promise((r) => setTimeout(r, 5000));
    }

    log(descriptor.name, 'NOT CONFIRMED after 5 minutes');
    await ctx.reply(`Not confirmed on-chain after 5 minutes. The order may still be pending execution — check manually before assuming this failed.`);
}

export async function startAdminActionFlow(bot: Bot, ctx: any, descriptor: AdminActionDescriptor, walletName: WalletName = 'telegram-wallet') {
    const chatId = ctx.chat.id;
    const connector = createConnector(chatId, walletName);

    // Same stale-session guard as startDeployFlow -- always disconnect and re-link.
    await connector.restoreConnection().catch(() => {});
    if (connector.connected) {
        await connector.disconnect().catch(() => {});
    }

    const proceed = async (rawOwnerAddress: string) => {
        const owner = Address.parseRaw(rawOwnerAddress);
        const callbackData = `confirm_action_${descriptor.name}_${Date.now()}`;
        pendingActionsByChatCallback.set(`${chatId}:${callbackData}`, { descriptor, owner, connector, wallet: walletName });

        await ctx.reply(
            `${descriptor.describe(owner)}\n\nTap to review and sign in your wallet. This spends ${descriptor.spendWarning}.`,
            { reply_markup: new InlineKeyboard().text(descriptor.name, callbackData) }
        );
    };

    const link = getConnectLink(connector, walletName);
    const kb = new InlineKeyboard().url('Connect Wallet', link);
    await ctx.reply(`Tap to connect your ${walletName}:`, { reply_markup: kb });

    try {
        const wallet = await waitForConnection(connector);
        log(descriptor.name, `WALLET CONNECTED: ${wallet.account.address}`);
        await proceed(wallet.account.address);
    } catch (e: any) {
        log(descriptor.name, `CONNECTION FAILED: ${e.message}`);
        await ctx.reply(`Connection failed or timed out: ${e.message}`);
    }
}

export async function startDeployFlow(bot: Bot, ctx: any, descriptor: DeployDescriptor) {
    const chatId = ctx.chat.id;
    const connector = createConnector(chatId);

    // Always disconnect any cached session before presenting a fresh link.
    // restoreConnection() can return a connector that claims connected but whose
    // bridge session the wallet has already dropped -- we have no reliable way to
    // ping liveness, so we always start fresh rather than silently firing a
    // sendTransaction into a dead channel.
    await connector.restoreConnection().catch(() => {});
    if (connector.connected) {
        await connector.disconnect().catch(() => {});
    }

    const proceed = async (rawOwnerAddress: string) => {
        const owner = Address.parseRaw(rawOwnerAddress);
        const callbackData = `confirm_deploy_${descriptor.name}`;
        pendingByChatCallback.set(`${chatId}:${callbackData}`, { descriptor, owner, connector, wallet: 'telegram-wallet' });

        await ctx.reply(
            `${descriptor.describe(owner)}\n\nTap Deploy to review and sign in your wallet. This spends ${descriptor.spendWarning} and cannot be undone.`,
            { reply_markup: new InlineKeyboard().text(`Deploy ${descriptor.name}`, callbackData) }
        );
    };

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
