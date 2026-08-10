import { Address, beginCell, Cell } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { CLAIM_ATTESTATION_MAGIC, attestationToCell, signatureToCell, OP_CLAIM } from '../wrappers/RewardVault';

const ORACLE_URL = 'https://tonkas-oracle.duck47783.workers.dev';

// Small fixed amount for the test claim: 1 token (9 decimals).
// The Vault's elapsed-time bound will accept anything up to
// baseRate(epoch0) * 2 * hoursSinceLastClaim -- a first-ever claim on a
// fresh ClaimAccount has lastClaimTime=0, so elapsed = now - 0 which is
// effectively uncapped in practice. We keep the amount tiny deliberately
// so the test exercises the full verification path without draining the bucket.
const TEST_AMOUNT = 1_000_000_000n; // 1 token

export async function buildTestClaimRequest(
    vaultAddress: Address,
    claimant: Address,
    fromAddress: Address
): Promise<SendTransactionRequest> {
    const nonce = BigInt(Date.now()); // unique per invocation; oracle doesn't track nonces (test-only)
    const validUntil = Math.floor(Date.now() / 1000) + 300; // 5 min window

    // Call the live oracle worker to sign the attestation.
    const resp = await fetch(`${ORACLE_URL}/sign/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            vault: vaultAddress.toString(),
            claimant: claimant.toString(),
            amount: TEST_AMOUNT.toString(),
            nonce: nonce.toString(),
            validUntil,
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Oracle /sign/claim failed ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { attestationBoc: string; signature: string; pubkey: string };

    // Re-build the attestation cell from BOC so we're signing exactly what the
    // contract will verify -- same bytes, not a re-serialisation.
    const attestationCell = Cell.fromBoc(Buffer.from(data.attestationBoc, 'base64'))[0];
    const sigBytes = Buffer.from(data.signature, 'hex');
    if (sigBytes.length !== 64) throw new Error(`Unexpected signature length: ${sigBytes.length}`);
    const signatureCell = signatureToCell(sigBytes);

    const body = beginCell()
        .storeUint(OP_CLAIM, 32)
        .storeUint(0n, 64) // queryId
        .storeRef(attestationCell)
        .storeRef(signatureCell)
        .endCell();

    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: vaultAddress.toString(),
                amount: (300_000_000n).toString(), // 0.3 TON gas; ClaimAccount deploy + jetton transfer
                payload: body.toBoc().toString('base64'),
            },
        ],
    };
}
