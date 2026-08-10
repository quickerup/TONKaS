import TonConnect, { Wallet, SendTransactionRequest, SendTransactionResponse } from '@tonconnect/sdk';
import { FileStorage } from './storage';

// Reusable across every future mainnet action this bot handles, not just the multisig
// deploy — see the commit that added this. TON Connect has no wallet-agnostic universal
// link — every wallet has its own bridge + link format (confirmed against the official
// wallets-v2.json registry) — so the wallet target is explicit, not guessed.
export type WalletName = 'telegram-wallet' | 'tonkeeper';

const WALLETS: Record<WalletName, { bridgeUrl: string; universalLink: string }> = {
    'telegram-wallet': {
        bridgeUrl: 'https://walletbot.me/tonconnect-bridge/bridge',
        universalLink: 'https://t.me/wallet?attach=wallet',
    },
    tonkeeper: {
        bridgeUrl: 'https://bridge.tonapi.io/bridge',
        universalLink: 'https://app.tonkeeper.com/ton-connect',
    },
};

const MANIFEST_URL = 'https://raw.githubusercontent.com/quickerup/TONKaS/main/tonconnect-manifest.json';

// Each wallet gets its own storage namespace -- reusing the same session file across
// different wallet targets would mix an old bridge session with a new one.
export function createConnector(chatId: number | string, wallet: WalletName = 'telegram-wallet'): TonConnect {
    return new TonConnect({
        manifestUrl: MANIFEST_URL,
        storage: new FileStorage(`${chatId}_${wallet}`),
    });
}

// Returns the universal link for the "Connect Wallet" button. The wallet's reply lands on
// connector.onStatusChange, not on this call's return value.
export function getConnectLink(connector: TonConnect, wallet: WalletName = 'telegram-wallet'): string {
    return connector.connect(WALLETS[wallet]);
}

// Re-opening the wallet's own app/attachment brings any request already pushed over the
// live bridge session (via sendTransaction below) to the front for review — TON Connect's
// bridge is push-based once connected; this link doesn't carry the transaction itself, the
// bridge message already sent it.
export function getReopenWalletLink(wallet: WalletName = 'telegram-wallet'): string {
    return WALLETS[wallet].universalLink;
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
