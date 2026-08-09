import { Address, beginCell } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';

// Minimal scope, per instruction: real key material and correct, testable signing against
// the exact struct shapes the contracts already verify against — not the full
// press-tracking pipeline, which depends on the Telegram bot existing and is separate,
// later scope. A manual-trigger signing endpoint is enough for now.

const CLAIM_ATTESTATION_MAGIC = 0x52565431; // "RVT1" -- contracts/constants.tolk
const REFERRAL_ATTESTATION_MAGIC = 0x52464d31; // "RFM1" -- contracts/constants.tolk

export interface Env {
    ORACLE_SEED: string; // hex-encoded 32-byte ed25519 seed, set via `wrangler secret put`
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function getKeyPair(env: Env) {
    const seed = Buffer.from(env.ORACLE_SEED, 'hex');
    if (seed.length !== 32) throw new Error('ORACLE_SEED must be a 32-byte hex string');
    return keyPairFromSeed(seed);
}

// struct ClaimAttestation { magic: uint32; vault: address; claimant: address; amount: coins;
// nonce: uint64; validUntil: uint32 } -- contracts/constants.tolk. Verified in
// ClaimAccount.tolk via isSignatureValid(attCell.hash(), signature, signerKey) -- signing
// target is the cell's own representation hash, nothing else.
function buildClaimAttestation(vault: Address, claimant: Address, amount: bigint, nonce: bigint, validUntil: number) {
    return beginCell()
        .storeUint(CLAIM_ATTESTATION_MAGIC, 32)
        .storeAddress(vault)
        .storeAddress(claimant)
        .storeCoins(amount)
        .storeUint(nonce, 64)
        .storeUint(validUntil, 32)
        .endCell();
}

// struct ReferralAttestation { magic: uint32; collection: address; claimant: address;
// nonce: uint64; validUntil: uint32 } -- contracts/constants.tolk. Domain-separated from
// ClaimAttestation by magic + field shape even though the same oracle key signs both.
function buildReferralAttestation(collection: Address, claimant: Address, nonce: bigint, validUntil: number) {
    return beginCell()
        .storeUint(REFERRAL_ATTESTATION_MAGIC, 32)
        .storeAddress(collection)
        .storeAddress(claimant)
        .storeUint(nonce, 64)
        .storeUint(validUntil, 32)
        .endCell();
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/pubkey' && request.method === 'GET') {
            const kp = getKeyPair(env);
            return json({ pubkey: kp.publicKey.toString('hex') });
        }

        if (url.pathname === '/sign/claim' && request.method === 'POST') {
            try {
                const body = (await request.json()) as any;
                const vault = Address.parse(body.vault);
                const claimant = Address.parse(body.claimant);
                const amount = BigInt(body.amount);
                const nonce = BigInt(body.nonce);
                const validUntil = Number(body.validUntil);

                const cell = buildClaimAttestation(vault, claimant, amount, nonce, validUntil);
                const kp = getKeyPair(env);
                const signature = sign(cell.hash(), kp.secretKey);

                return json({
                    attestationBoc: cell.toBoc().toString('base64'),
                    signature: signature.toString('hex'),
                    pubkey: kp.publicKey.toString('hex'),
                });
            } catch (e: any) {
                return json({ error: e.message }, 400);
            }
        }

        if (url.pathname === '/sign/referral' && request.method === 'POST') {
            try {
                const body = (await request.json()) as any;
                const collection = Address.parse(body.collection);
                const claimant = Address.parse(body.claimant);
                const nonce = BigInt(body.nonce);
                const validUntil = Number(body.validUntil);

                const cell = buildReferralAttestation(collection, claimant, nonce, validUntil);
                const kp = getKeyPair(env);
                const signature = sign(cell.hash(), kp.secretKey);

                return json({
                    attestationBoc: cell.toBoc().toString('base64'),
                    signature: signature.toString('hex'),
                    pubkey: kp.publicKey.toString('hex'),
                });
            } catch (e: any) {
                return json({ error: e.message }, 400);
            }
        }

        return json({ error: 'not found' }, 404);
    },
};
