import { Address, beginCell, storeStateInit, toNano, Cell } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { Router, RouterConfig } from '../wrappers/Router';

export const MIN_CYCLE_VALUE = toNano('10'); // 10 TON
export const MIN_CYCLE_INTERVAL = 6 * 3600; // 6 hours
export const CRANK_BOUNTY_BPS = 150; // 1.5%

export const STONFI_ROUTER = Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');
export const PTON_WALLET = Address.parse('EQACuz151snlY46PKdUOkyiCf0zzcxMsN6XmKQkSKZjkvyFH');
export const STONFI_TONKAS_WALLET = Address.parse('EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt');
export const QUOTE_SIGNER_KEY = 0n; // Placeholder for now

export function buildRouterConfig(
    admin: Address,
    locker: Address,
    rewardJettonWallet: Address // Placeholder initially, set via SetRewardJettonWallet later
): RouterConfig {
    return {
        admin,
        locker,
        stonfiRouter: STONFI_ROUTER,
        stonfiTonkasWallet: STONFI_TONKAS_WALLET,
        ptonWallet: PTON_WALLET,
        quoteSignerKey: QUOTE_SIGNER_KEY,
        rewardJettonWallet,
        minCycleValue: MIN_CYCLE_VALUE,
        minCycleInterval: MIN_CYCLE_INTERVAL,
        crankBountyBps: CRANK_BOUNTY_BPS,
    };
}

export function computeRouterAddress(
    admin: Address,
    locker: Address,
    rewardJettonWallet: Address,
    code: Cell
): { router: Router; address: Address } {
    const config = buildRouterConfig(admin, locker, rewardJettonWallet);
    const router = Router.createFromConfig(config, code);
    return { router, address: router.address };
}

export function buildRouterDeployRequest(router: Router, fromAddress: Address): SendTransactionRequest {
    if (!router.init) throw new Error('router.init is missing');
    const stateInit = beginCell().store(storeStateInit(router.init)).endCell();
    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: router.address.toString(),
                amount: toNano('0.05').toString(),
                stateInit: stateInit.toBoc().toString('base64'),
                payload: beginCell().endCell().toBoc().toString('base64'),
            },
        ],
    };
}
