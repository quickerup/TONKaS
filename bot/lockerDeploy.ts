import { Address, beginCell, storeStateInit, toNano, Cell } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { LiquidityLocker, liquidityLockerConfigToCell } from '../wrappers/LiquidityLocker';

const DEPLOY_VALUE = toNano('0.05'); // rent-exempt reserve only -- the contract holds no state, has no admin, needs no gas budget for anything

// No admin, no privileged functions anywhere in LiquidityLocker.tolk by design -- see that
// file's header. Any wallet can send this deploy message; who sends it doesn't matter to
// the contract's own logic. Address is always computed fresh from the current build
// artifact at deploy time, never hardcoded -- see pinned-hashes.json and the commit that
// added it for why a hand-computed address isn't trustworthy on its own.
export function computeLockerAddress(code: Cell): { locker: LiquidityLocker; address: Address } {
    const locker = LiquidityLocker.createFromConfig({}, code);
    return { locker, address: locker.address };
}

export function buildLockerDeployRequest(locker: LiquidityLocker, fromAddress: Address): SendTransactionRequest {
    if (!locker.init) throw new Error('locker.init is missing -- was it created via LiquidityLocker.createFromConfig?');

    const stateInit = beginCell().store(storeStateInit(locker.init)).endCell();

    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: locker.address.toString(),
                amount: DEPLOY_VALUE.toString(),
                stateInit: stateInit.toBoc().toString('base64'),
                payload: beginCell().endCell().toBoc().toString('base64'),
            },
        ],
    };
}
