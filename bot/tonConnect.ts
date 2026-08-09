import TonConnect, { Wallet, SendTransactionRequest, SendTransactionResponse } from '@tonconnect/sdk';
import { FileStorage } from './storage';

// Reusable across every future mainnet action this bot handles, not just the multisig
// deploy — see the commit that added this. Targets Telegram Wallet specifically: it's
// the wallet confirmed as the one holding the signer key for this project, and it opens
// as a Telegram attachment rather than switching to a separate app, which is the fit the
// "native to the chat" requirement calls for. TON Connect has no wallet-agnostic universal
// link — every wallet has its own bridge + link format (confirmed against the official
// wallets-v2.json registry) — so this is a deliberate, not arbitrary, choice.
const TELEGRAM_WALLET = {
    bridgeUrl: 'https://walletbot.me/tonconnect-bridge/bridge',
    universalLink: 'https://t.me/wallet?attach=wallet',
};

const MANIFEST_URL = 'https://raw.githubusercontent.com/quickerup/TONKaS/main/tonconnect-manifest.json';

export function createConnector(chatId: number | string): TonConnect {
    return new TonConnect({
        manifestUrl: MANIFEST_URL,
        storage: new FileStorage(chatId),
    });
}

// Returns the universal link for the "Connect Wallet" button. The wallet's reply lands on
// connector.onStatusChange, not on this call's return value.
export function getConnectLink(connector: TonConnect): string {
    return connector.connect(TELEGRAM_WALLET);
}

// Re-opening Telegram Wallet's own attachment brings any request already pushed over the
// live bridge session (via sendTransaction below) to the front for review — TON Connect's
// bridge is push-based once connected; this link doesn't carry the transaction itself, the
// bridge message already sent it.
export function getReopenWalletLink(): string {
    return TELEGRAM_WALLET.universalLink;
}

// Fires the request over the bridge and resolves with the wallet's signed reply (or
// rejects on wallet-side rejection/timeout). Callers should show the reopen-wallet button
// immediately after calling this, not after it resolves — the wallet needs to be brought
// to the foreground to see the pending request before it will show anything to the person.
export async function requestTransaction(
    connector: TonConnect,
    request: SendTransactionRequest
): Promise<SendTransactionResponse> {
    return connector.sendTransaction(request);
}

export function waitForConnection(connector: TonConnect, timeoutMs = 5 * 60 * 1000): Promise<Wallet> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error('Timed out waiting for wallet connection'));
        }, timeoutMs);
        const unsubscribe = connector.onStatusChange(
            (wallet) => {
                if (wallet) {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(wallet);
                }
            },
            (err) => {
                clearTimeout(timer);
                unsubscribe();
                reject(err);
            }
        );
    });
}
