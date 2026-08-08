import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import {
    SkipCollection,
    offchainContent,
    ReferralAttestation,
    referralAttestationToCell,
    referralSignatureToCell,
    signReferralAttestation,
    REFERRAL_ATTESTATION_MAGIC,
    TIER_24H_SKIP,
    TIER_FOREVER,
} from '../wrappers/SkipCollection';
import { SkipItem } from '../wrappers/SkipItem';
import { ReferralAccount } from '../wrappers/ReferralAccount';
import { attestationToCell, CLAIM_ATTESTATION_MAGIC, ClaimAttestation } from '../wrappers/RewardVault';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

jest.setTimeout(30000);

const SKIP_24H_PRICE = toNano('5');
const SKIP_FOREVER_PRICE = toNano('10');

describe('SkipCollection', () => {
    let itemCode: Cell;
    let referralAccountCode: Cell;
    let collectionCode: Cell;
    let oracle: ReturnType<typeof keyPairFromSeed>;
    let wrongOracle: ReturnType<typeof keyPairFromSeed>;

    beforeAll(async () => {
        itemCode = await compile('SkipItem');
        referralAccountCode = await compile('ReferralAccount');
        collectionCode = await compile('SkipCollection');
        oracle = keyPairFromSeed(Buffer.alloc(32, 11));
        wrongOracle = keyPairFromSeed(Buffer.alloc(32, 13));
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let router: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<SkipCollection>;

    const baseConfig = (bucketCapacity = 10) => ({
        admin: admin.address,
        router: router.address,
        signerKey: BigInt('0x' + oracle.publicKey.toString('hex')),
        itemCode,
        referralAccountCode,
        collectionContent: offchainContent('https://example.test/collection.json'),
        content24h: offchainContent('https://example.test/skip-24h.json'),
        contentForever: offchainContent('https://example.test/skip-forever.json'),
        paused: false,
        freeMintBucketCapacity: bucketCapacity,
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        router = await blockchain.treasury('router');

        collection = blockchain.openContract(SkipCollection.createFromConfig(baseConfig(), collectionCode));
        const deployResult = await collection.sendDeploy(admin.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({ from: admin.address, to: collection.address, deploy: true, success: true });
    });

    function itemAt(index: bigint): SandboxContract<SkipItem> {
        const addr = SkipItem.createFromConfig({ collection: collection.address, index }, itemCode).address;
        return blockchain.openContract(SkipItem.createFromAddress(addr));
    }

    function referralAccountFor(owner: Address): SandboxContract<ReferralAccount> {
        const addr = ReferralAccount.createFromConfig({ collection: collection.address, owner }, referralAccountCode).address;
        return blockchain.openContract(ReferralAccount.createFromAddress(addr));
    }

    async function makeReferralAttestation(
        claimant: Address,
        opts: { nonce?: bigint; validUntil?: number; magic?: number; collection?: Address; signer?: ReturnType<typeof keyPairFromSeed> } = {}
    ): Promise<{ attestation: ReferralAttestation; signature: Buffer }> {
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const attestation: ReferralAttestation = {
            magic: opts.magic ?? REFERRAL_ATTESTATION_MAGIC,
            collection: opts.collection ?? collection.address,
            claimant,
            nonce: opts.nonce ?? 1n,
            validUntil: opts.validUntil ?? now + 3600,
        };
        const signer = opts.signer ?? oracle;
        const signature = sign(referralAttestationToCell(attestation).hash(), signer.secretKey);
        return { attestation, signature };
    }

    async function sendReferralClaim(sender: SandboxContract<TreasuryContract>, attestation: ReferralAttestation, signature: Buffer, queryId = 1n) {
        return collection.sendReferralClaim(sender.getSender(), {
            queryId,
            attestationCell: referralAttestationToCell(attestation),
            signatureCell: referralSignatureToCell(signature),
            value: toNano('0.3'),
        });
    }

    it('deploys with the resolved params', async () => {
        expect(await collection.getAdminAddress()).toEqualAddress(admin.address);
        expect(await collection.getRouterAddress()).toEqualAddress(router.address);
        expect(await collection.getIsPaused()).toBe(false);
        const bucket = await collection.getFreeMintBucketState();
        expect(bucket.capacity).toBe(10);
        expect(bucket.available).toBe(10);
        const data = await collection.getCollectionData();
        expect(data.nextItemIndex).toBe(0n);
        expect(data.admin).toEqualAddress(admin.address);
    });

    it('get_nft_address_by_index is predictable before mint and matches the address actually minted to', async () => {
        const predicted = await collection.getNftAddressByIndex(0n);
        expect(predicted).toEqualAddress(itemAt(0n).address);

        const buyer = await blockchain.treasury('buyer');
        await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_24H_SKIP, value: SKIP_24H_PRICE + toNano('0.2') });

        const data = await itemAt(0n).getNftData();
        expect(data.initialized).toBe(true);
        expect(data.owner).toEqualAddress(buyer.address);
    });

    it('paid mint: 24h-skip charges exactly 5 TON, forwards to router, refunds excess', async () => {
        const buyer = await blockchain.treasury('buyer');
        const routerBefore = (await blockchain.getContract(router.address)).balance;

        const result = await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_24H_SKIP, value: SKIP_24H_PRICE + toNano('0.5') });

        expect(result.transactions).toHaveTransaction({ from: collection.address, to: itemAt(0n).address, deploy: true, success: true });
        expect(result.transactions).toHaveTransaction({ from: collection.address, to: buyer.address, success: true }); // refund

        const item = await itemAt(0n).getNftData();
        expect(item.owner).toEqualAddress(buyer.address);
        const activation = await itemAt(0n).getActivationState();
        expect(activation.tier).toBe(TIER_24H_SKIP);
        expect(activation.activatedAt).toBe(0);

        const routerAfter = (await blockchain.getContract(router.address)).balance;
        expect(routerAfter - routerBefore).toBeGreaterThan(0n);
        expect(routerAfter - routerBefore).toBeLessThanOrEqual(SKIP_24H_PRICE);
        expect(routerAfter - routerBefore).toBeGreaterThan(SKIP_24H_PRICE - toNano('0.001'));
    });

    it('paid mint: Forever charges exactly 10 TON and is a distinct tier', async () => {
        const buyer = await blockchain.treasury('buyer');
        await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_FOREVER, value: SKIP_FOREVER_PRICE + toNano('0.3') });

        const activation = await itemAt(0n).getActivationState();
        expect(activation.tier).toBe(TIER_FOREVER);
    });

    it('rejects paid mint below the tier price', async () => {
        const buyer = await blockchain.treasury('buyer');
        const result = await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_24H_SKIP, value: toNano('1') });

        expect(result.transactions).toHaveTransaction({ from: buyer.address, to: collection.address, success: false, exitCode: 403 }); // ERR_INSUFFICIENT
    });

    it('rejects paid mint while paused, and only admin can pause', async () => {
        const buyer = await blockchain.treasury('buyer');
        const notAdmin = await blockchain.treasury('notAdmin');

        const bad = await collection.sendSetPaused(notAdmin.getSender(), { paused: true, value: toNano('0.05') });
        expect(bad.transactions).toHaveTransaction({ from: notAdmin.address, to: collection.address, success: false, exitCode: 401 });

        await collection.sendSetPaused(admin.getSender(), { paused: true, value: toNano('0.05') });
        const result = await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_24H_SKIP, value: SKIP_24H_PRICE + toNano('0.3') });
        expect(result.transactions).toHaveTransaction({ from: buyer.address, to: collection.address, success: false, exitCode: 408 }); // ERR_PAUSED
    });

    it('activation: 24h-skip is repeatably re-activatable by its owner (a recurring card-swipe, not a single-use voucher); Forever cannot be activated at all', async () => {
        const buyer = await blockchain.treasury('buyer');
        await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_24H_SKIP, value: SKIP_24H_PRICE + toNano('0.3') });
        const item = itemAt(0n);

        const notOwner = await blockchain.treasury('notOwner');
        const badActivate = await item.sendActivate(notOwner.getSender(), { value: toNano('0.05') });
        expect(badActivate.transactions).toHaveTransaction({ from: notOwner.address, to: item.address, success: false, exitCode: 401 });

        await item.sendActivate(buyer.getSender(), { value: toNano('0.05') });
        const afterFirst = await item.getActivationState();
        expect(afterFirst.activatedAt).toBeGreaterThan(0);

        // a second activation must succeed (not ERR_REPLAY) and actually advance activatedAt —
        // this is the whole point of the repeatable model: the owner can refresh the window
        // any time, indefinitely, for as long as they hold the item.
        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 3600;
        const second = await item.sendActivate(buyer.getSender(), { value: toNano('0.05') });
        expect(second.transactions).toHaveTransaction({ from: buyer.address, to: item.address, success: true });
        const afterSecond = await item.getActivationState();
        expect(afterSecond.activatedAt).toBeGreaterThan(afterFirst.activatedAt);

        // and a third, well after the first would have "expired" under the old model
        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 3600;
        const third = await item.sendActivate(buyer.getSender(), { value: toNano('0.05') });
        expect(third.transactions).toHaveTransaction({ from: buyer.address, to: item.address, success: true });
        const afterThird = await item.getActivationState();
        expect(afterThird.activatedAt).toBeGreaterThan(afterSecond.activatedAt);

        // Forever
        await collection.sendPaidMint(buyer.getSender(), { queryId: 2n, tier: TIER_FOREVER, value: SKIP_FOREVER_PRICE + toNano('0.3') });
        const foreverItem = itemAt(1n);
        const foreverActivate = await foreverItem.sendActivate(buyer.getSender(), { value: toNano('0.05') });
        expect(foreverActivate.transactions).toHaveTransaction({ from: buyer.address, to: foreverItem.address, success: false, exitCode: 0xffff }); // ERR_WRONG_OP
    });

    it('standard transfer works for both tiers (neither soulbound)', async () => {
        const buyer = await blockchain.treasury('buyer');
        const recipient = await blockchain.treasury('recipient');
        await collection.sendPaidMint(buyer.getSender(), { queryId: 1n, tier: TIER_FOREVER, value: SKIP_FOREVER_PRICE + toNano('0.3') });
        const item = itemAt(0n);

        const result = await item.sendTransfer(buyer.getSender(), { newOwner: recipient.address, responseDestination: buyer.address, value: toNano('0.1') });
        expect(result.transactions).toHaveTransaction({ from: buyer.address, to: item.address, success: true });

        const data = await item.getNftData();
        expect(data.owner).toEqualAddress(recipient.address);

        // old owner can no longer transfer it
        const bad = await item.sendTransfer(buyer.getSender(), { newOwner: buyer.address, value: toNano('0.1') });
        expect(bad.transactions).toHaveTransaction({ from: buyer.address, to: item.address, success: false, exitCode: 401 });
    });

    it('referral mint: valid attestation succeeds, deducts from the bucket, mints TIER_24H_SKIP regardless', async () => {
        const claimant = await blockchain.treasury('claimant');
        const { attestation, signature } = await makeReferralAttestation(claimant.address);

        const bucketBefore = await collection.getFreeMintBucketState();
        const result = await sendReferralClaim(claimant, attestation, signature);

        expect(result.transactions).toHaveTransaction({ from: collection.address, to: itemAt(0n).address, deploy: true, success: true });
        const activation = await itemAt(0n).getActivationState();
        expect(activation.tier).toBe(TIER_24H_SKIP);

        const bucketAfter = await collection.getFreeMintBucketState();
        expect(bucketAfter.available).toBe(bucketBefore.available - 1);

        const refAccount = referralAccountFor(claimant.address);
        expect(await refAccount.getLastReferralNonce()).toBe(1n);
    });

    it('rejects referral replay of the same nonce', async () => {
        const claimant = await blockchain.treasury('claimant');
        const first = await makeReferralAttestation(claimant.address, { nonce: 1n });
        await sendReferralClaim(claimant, first.attestation, first.signature, 1n);

        const replay = await makeReferralAttestation(claimant.address, { nonce: 1n });
        const result = await sendReferralClaim(claimant, replay.attestation, replay.signature, 2n);

        expect(result.transactions).toHaveTransaction({
            from: collection.address,
            to: referralAccountFor(claimant.address).address,
            success: false,
            exitCode: 407, // ERR_REPLAY
        });
    });

    it('rejects an expired referral attestation', async () => {
        const claimant = await blockchain.treasury('claimant');
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const { attestation, signature } = await makeReferralAttestation(claimant.address, { validUntil: now - 10 });

        const result = await sendReferralClaim(claimant, attestation, signature);
        expect(result.transactions).toHaveTransaction({
            from: collection.address,
            to: referralAccountFor(claimant.address).address,
            success: false,
            exitCode: 406, // ERR_EXPIRED
        });
    });

    it('rejects a referral attestation signed by the wrong key', async () => {
        const claimant = await blockchain.treasury('claimant');
        const { attestation, signature } = await makeReferralAttestation(claimant.address, { signer: wrongOracle });

        const result = await sendReferralClaim(claimant, attestation, signature);
        expect(result.transactions).toHaveTransaction({
            from: collection.address,
            to: referralAccountFor(claimant.address).address,
            success: false,
            exitCode: 405, // ERR_BAD_SIGNATURE
        });
    });

    it('CROSS-CONTEXT REPLAY: a validly-shaped, validly-signed Vault ClaimAttestation must be rejected here', async () => {
        const claimant = await blockchain.treasury('claimant');
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);

        // A fully valid Vault-style attestation: real CLAIM_ATTESTATION_MAGIC, signed with the
        // SAME oracle key the collection trusts (this is the whole point of the test — the key
        // is shared across contexts, so only the magic+struct-shape difference protects us).
        const claimAttestation: ClaimAttestation = {
            magic: CLAIM_ATTESTATION_MAGIC,
            vault: collection.address, // arbitrary — a real Vault address in production, doesn't matter for this test
            claimant: claimant.address,
            amount: 1000n * 1000000000n,
            nonce: 1n,
            validUntil: now + 3600,
        };
        const claimCell = attestationToCell(claimAttestation);
        const signature = sign(claimCell.hash(), oracle.secretKey); // valid signature, real oracle key

        // Submit the exact same cell, unmodified, as if it were a ReferralAttestation.
        const result = await collection.sendReferralClaim(claimant.getSender(), {
            queryId: 1n,
            attestationCell: claimCell,
            signatureCell: referralSignatureToCell(signature),
            value: toNano('0.3'),
        });

        // ClaimAttestation carries an extra `amount: coins` field ReferralAttestation doesn't,
        // so the two structs are different bit-widths — Cell<ReferralAttestation>.load() hits a
        // hard TVM parse failure (exit 9, "Cell underflow") before the magic check even runs.
        // That's a STRONGER rejection than the magic check alone (fails to even parse, rather
        // than parsing and then being rejected on a field value) — but to isolate the magic
        // check itself, see the next test, which uses a shape-compatible payload with only the
        // magic wrong.
        expect(result.transactions).toHaveTransaction({
            from: collection.address,
            to: referralAccountFor(claimant.address).address,
            success: false,
            exitCode: 9, // Cell underflow — shape mismatch caught before any field is even read
        });

        // and nothing was minted
        expect(await collection.getNextItemIndex()).toBe(0n);
    });

    it('CROSS-CONTEXT REPLAY (magic check isolated): a shape-compatible payload with only the wrong magic is rejected by assert(magic == REFERRAL_ATTESTATION_MAGIC)', async () => {
        const claimant = await blockchain.treasury('claimant');
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);

        // Same shape as a real ReferralAttestation (magic, collection, claimant, nonce,
        // validUntil — no amount field), but stamped with CLAIM_ATTESTATION_MAGIC instead of
        // REFERRAL_ATTESTATION_MAGIC, signed with the shared oracle key. This is the precise
        // "domain separation" scenario: identical struct shape, identical key, only the magic
        // constant differs — so if the magic check were missing or wrong, this would mint.
        const { attestation, signature } = await makeReferralAttestation(claimant.address, { magic: CLAIM_ATTESTATION_MAGIC });

        const result = await sendReferralClaim(claimant, attestation, signature);

        expect(result.transactions).toHaveTransaction({
            from: collection.address,
            to: referralAccountFor(claimant.address).address,
            success: false,
            exitCode: 405, // ERR_BAD_SIGNATURE — specifically from assert(att.magic == REFERRAL_ATTESTATION_MAGIC)
        });
        expect(await collection.getNextItemIndex()).toBe(0n);
    });

    it('exhausts the free-mint bucket, rejects further referral claims, then refills after time passes', async () => {
        const smallBucket = blockchain.openContract(SkipCollection.createFromConfig(baseConfig(2), collectionCode));
        await smallBucket.sendDeploy(admin.getSender(), toNano('0.05'));

        const claimants = await Promise.all([1, 2, 3].map((i) => blockchain.treasury(`refClaimant${i}`)));

        for (let i = 0; i < 2; i++) {
            const now = blockchain.now ?? Math.floor(Date.now() / 1000);
            const attestation: ReferralAttestation = {
                magic: REFERRAL_ATTESTATION_MAGIC,
                collection: smallBucket.address,
                claimant: claimants[i].address,
                nonce: 1n,
                validUntil: now + 3600,
            };
            const signature = signReferralAttestation(attestation, oracle.secretKey);
            const result = await smallBucket.sendReferralClaim(claimants[i].getSender(), {
                queryId: 1n,
                attestationCell: referralAttestationToCell(attestation),
                signatureCell: referralSignatureToCell(signature),
                value: toNano('0.3'),
            });
            const refAccountAddr = ReferralAccount.createFromConfig({ collection: smallBucket.address, owner: claimants[i].address }, referralAccountCode).address;
            expect(result.transactions).toHaveTransaction({ from: refAccountAddr, to: smallBucket.address, success: true });
        }

        const bucketExhausted = await smallBucket.getFreeMintBucketState();
        expect(bucketExhausted.available).toBe(0);

        // third claimant: bucket exhausted
        const now1 = blockchain.now ?? Math.floor(Date.now() / 1000);
        const thirdAttestation: ReferralAttestation = {
            magic: REFERRAL_ATTESTATION_MAGIC,
            collection: smallBucket.address,
            claimant: claimants[2].address,
            nonce: 1n,
            validUntil: now1 + 3600,
        };
        const thirdSignature = signReferralAttestation(thirdAttestation, oracle.secretKey);
        const exhaustedResult = await smallBucket.sendReferralClaim(claimants[2].getSender(), {
            queryId: 1n,
            attestationCell: referralAttestationToCell(thirdAttestation),
            signatureCell: referralSignatureToCell(thirdSignature),
            value: toNano('0.3'),
        });
        const thirdRefAccountAddr = ReferralAccount.createFromConfig({ collection: smallBucket.address, owner: claimants[2].address }, referralAccountCode).address;
        expect(exhaustedResult.transactions).toHaveTransaction({ from: thirdRefAccountAddr, to: smallBucket.address, success: false, exitCode: 409 }); // ERR_BUSY

        // advance time by one refill period (4h) and retry — should succeed now
        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 4 * 3600 + 10;
        const retryAttestation: ReferralAttestation = { ...thirdAttestation, nonce: 2n, validUntil: (blockchain.now ?? 0) + 3600 };
        const retrySignature = signReferralAttestation(retryAttestation, oracle.secretKey);
        const retryResult = await smallBucket.sendReferralClaim(claimants[2].getSender(), {
            queryId: 2n,
            attestationCell: referralAttestationToCell(retryAttestation),
            signatureCell: referralSignatureToCell(retrySignature),
            value: toNano('0.3'),
        });
        expect(retryResult.transactions).toHaveTransaction({ from: thirdRefAccountAddr, to: smallBucket.address, success: true });
    });

    it('only the admin can change router/signerKey', async () => {
        const notAdmin = await blockchain.treasury('notAdmin');
        const newRouter = await blockchain.treasury('newRouter');
        const newKey = keyPairFromSeed(Buffer.alloc(32, 3));

        const badRouter = await collection.sendSetRouter(notAdmin.getSender(), { router: newRouter.address, value: toNano('0.05') });
        expect(badRouter.transactions).toHaveTransaction({ from: notAdmin.address, to: collection.address, success: false, exitCode: 401 });
        await collection.sendSetRouter(admin.getSender(), { router: newRouter.address, value: toNano('0.05') });
        expect(await collection.getRouterAddress()).toEqualAddress(newRouter.address);

        const badKey = await collection.sendSetSignerKey(notAdmin.getSender(), { signerKey: BigInt('0x' + newKey.publicKey.toString('hex')), value: toNano('0.05') });
        expect(badKey.transactions).toHaveTransaction({ from: notAdmin.address, to: collection.address, success: false, exitCode: 401 });
        await collection.sendSetSignerKey(admin.getSender(), { signerKey: BigInt('0x' + newKey.publicKey.toString('hex')), value: toNano('0.05') });
        expect(await collection.getSignerKey()).toBe(BigInt('0x' + newKey.publicKey.toString('hex')));
    });

    it('timelocks raising the free-mint bucket capacity: cannot apply before the delay, can after', async () => {
        const newCapacity = 20;
        const notAdmin = await blockchain.treasury('notAdmin');

        const badPropose = await collection.sendProposeLimits(notAdmin.getSender(), { freeMintBucketCapacity: newCapacity, value: toNano('0.05') });
        expect(badPropose.transactions).toHaveTransaction({ from: notAdmin.address, to: collection.address, success: false, exitCode: 401 });

        await collection.sendProposeLimits(admin.getSender(), { freeMintBucketCapacity: newCapacity, value: toNano('0.05') });

        const tooEarly = await collection.sendApplyLimits(admin.getSender(), { value: toNano('0.05') });
        expect(tooEarly.transactions).toHaveTransaction({ from: admin.address, to: collection.address, success: false, exitCode: 409 }); // ERR_BUSY

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 172800 + 10;
        await collection.sendApplyLimits(admin.getSender(), { value: toNano('0.05') });

        const bucket = await collection.getFreeMintBucketState();
        expect(bucket.capacity).toBe(newCapacity);
    });
});
