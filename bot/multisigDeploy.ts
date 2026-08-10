import { Address, beginCell, storeStateInit, toNano } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { Multisig, MultisigConfig } from '../wrappers/Multisig';

const DEPLOY_VALUE = toNano('0.1'); // rent-exempt reserve + gas headroom; the multisig itself holds no other state

// 1 signer, threshold 1 — just the connected wallet, for now. Adding signers later is a
// normal multisig UpdateRequest against the deployed contract, not something decided here.
export function buildMultisigConfig(ownerAddress: Address): MultisigConfig {
    return {
        threshold: 1,
        signers: [ownerAddress],
        proposers: [],
        allowArbitrarySeqno: true,
    };
}

export function computeMultisigAddress(ownerAddress: Address, code: import('@ton/core').Cell): { multisig: Multisig; address: Address } {
    const multisig = Multisig.createFromConfig(buildMultisigConfig(ownerAddress), code);
    return { multisig, address: multisig.address };
}

// TON Connect's `stateInit` field wants the serialized StateInit TL-B structure, not a
// bare code/data pair — @ton/core's storeStateInit builds that correctly.
export function buildDeployRequest(multisig: Multisig, fromAddress: Address): SendTransactionRequest {
    if (!multisig.init) throw new Error('multisig.init is missing — was it created via Multisig.createFromConfig?');

    const stateInit = beginCell().store(storeStateInit(multisig.init)).endCell();
    const body = beginCell().storeUint(0, 32).storeUint(0, 64).endCell(); // op=0, queryId=0 — matches Multisig.ts's own sendDeploy

    return {
        validUntil: Math.floor(Date.now() / 1000) + 280, // TON Connect / Telegram Wallet caps this at 5 minutes -- see the commit that fixed this across every request builder
        from: fromAddress.toRawString(),
        messages: [
            {
                address: multisig.address.toString(),
                amount: DEPLOY_VALUE.toString(),
                stateInit: stateInit.toBoc().toString('base64'),
                payload: body.toBoc().toString('base64'),
            },
        ],
    };
}
