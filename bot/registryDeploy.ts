import { Address, beginCell, storeStateInit, toNano, Cell } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { SlotRegistry, SlotRegistryConfig, CurveParams } from '../wrappers/SlotRegistry';

const DEPLOY_VALUE = toNano('0.05');

// price(n) = 1 TON * 1.15^n, n = current extraSlots (0-indexed), MAX_SLOTS = 100.
// 1.15 = 23/20 exactly -- see docs/tokenomics.md "Registry" and scripts/deploySlotRegistry.ts
// (the original, non-network-aware version this supersedes for the real mainnet deploy).
export const CURVE: CurveParams = {
    basePrice: toNano('1'),
    num: 23,
    den: 20,
    maxSlots: 100,
};

export function buildRegistryConfig(admin: Address, accountCode: Cell): SlotRegistryConfig {
    // Router isn't deployed until Step 5 -- admin is a safe, correctable placeholder here
    // (SetRouter is admin-gated and always available), matching the same pattern the old
    // placeholder-admin deploy script used for the same reason.
    return {
        admin,
        router: admin,
        accountCode,
        curve: CURVE,
        paused: false,
    };
}

export function computeRegistryAddress(admin: Address, registryCode: Cell, accountCode: Cell): { registry: SlotRegistry; address: Address } {
    const registry = SlotRegistry.createFromConfig(buildRegistryConfig(admin, accountCode), registryCode);
    return { registry, address: registry.address };
}

export function buildRegistryDeployRequest(registry: SlotRegistry, fromAddress: Address): SendTransactionRequest {
    if (!registry.init) throw new Error('registry.init is missing -- was it created via SlotRegistry.createFromConfig?');

    const stateInit = beginCell().store(storeStateInit(registry.init)).endCell();

    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: registry.address.toString(),
                amount: DEPLOY_VALUE.toString(),
                stateInit: stateInit.toBoc().toString('base64'),
                payload: beginCell().endCell().toBoc().toString('base64'),
            },
        ],
    };
}
