import { Address, Cell, SendMode, internal, toNano } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { Multisig } from '../wrappers/Multisig';

// Every admin-gated call from here on (SetJettonWallet, SetRouter, unpausing Router, etc.)
// has to go through the multisig as a new_order -- with threshold 1 and the connected
// wallet as the sole signer (addrIdx 0, isSigner true), the order executes immediately in
// the same logical flow (the multisig's own "approve_on_init" behavior), no separate
// approval step needed. See ton-blockchain/multisig-contract-v2's README for the order
// lifecycle this wraps.

// Real on-chain minimum, confirmed via get_order_estimate against the actual deployed
// multisig for two different order shapes (SetSignerKey's 256-bit payload and a plain
// transfer): ~0.0027-0.0028 TON either way -- order-processing overhead barely varies with
// payload size at this scale. 0.15 TON is ~50x that, solid margin without the earlier 1 TON
// value's ~10x overshoot (harmless -- excess refunds to the multisig -- but not necessary).
// This only covers the multisig's OWN order-processing overhead; it is NOT the value
// available to forward to the target -- that's targetValue below, drawn from the multisig's
// own pre-existing balance, not from this amount.
const ORDER_VALUE = toNano('0.15');

// `init` lets an order action be a full contract deploy funded from the multisig's own
// balance, not just a call to an already-existing address. Confirmed necessary rather than
// assumed: multisig.ton.org's order UI has no stateInit field anywhere -- checked every one
// of its order types directly, including the generic "Arbitrary order" fallback -- so a
// deploy-carrying order has to be built with this tooling, not their UI.
export function buildOrderRequest(
    multisigAddress: Address,
    target: Address,
    targetValue: bigint,
    body: Cell,
    fromAddress: Address,
    init?: { code: Cell; data: Cell }
): SendTransactionRequest {
    const orderId = BigInt(Date.now()); // allowArbitrarySeqno=true at deploy -- any unused value works, timestamp is simplest
    const expirationDate = Math.floor(Date.now() / 1000) + 3600; // 1h to actually tap through

    const msgBody = Multisig.newOrderMessage(
        [
            {
                type: 'transfer',
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                message: internal({ to: target, value: targetValue, body, init }),
            },
        ],
        expirationDate,
        true, // isSigner
        0, // addrIdx -- the sole signer in a 1-of-1 multisig
        orderId
    );

    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: multisigAddress.toString(),
                amount: ORDER_VALUE.toString(),
                payload: msgBody.toBoc().toString('base64'),
            },
        ],
    };
}
