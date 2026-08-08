import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { RewardVault, RewardVaultConfig, ClaimAttestation, attestationToCell, signAttestation, CLAIM_ATTESTATION_MAGIC } from '../wrappers/RewardVault';
import { ClaimAccount } from '../wrappers/ClaimAccount';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

jest.setTimeout(30000);

const DECIMALS = 1000000000n;
const HALVING_INTERVAL = 1_000_000_000n * DECIMALS;
const BASE_RATE = 456621n * DECIMALS; // tokens/hour at epoch 0
const CAPPED_CEILING = BASE_RATE * 2n; // epochRate(epoch 0) * 2
const MAX_PER_CLAIM = 10_000_000n * DECIMALS;
const BUCKET_CAPACITY = 150_000_000n * DECIMALS;

describe('RewardVault', () => {
    let claimAccountCode: Cell;
    let vaultCode: Cell;
    let oracle: ReturnType<typeof keyPairFromSeed>;
    let wrongOracle: ReturnType<typeof keyPairFromSeed>;

    beforeAll(async () => {
        claimAccountCode = await compile('ClaimAccount');
        vaultCode = await compile('RewardVault');
        oracle = keyPairFromSeed(Buffer.alloc(32, 7));
        wrongOracle = keyPairFromSeed(Buffer.alloc(32, 9));
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let jettonWallet: SandboxContract<TreasuryContract>;
    let vault: SandboxContract<RewardVault>;

    const baseConfig = (): RewardVaultConfig => ({
        admin: admin.address,
        signerKey: BigInt('0x' + oracle.publicKey.toString('hex')),
        jettonWallet: jettonWallet.address,
        claimAccountCode,
        halvingInterval: HALVING_INTERVAL,
        baseRate: BASE_RATE,
        maxPerClaim: MAX_PER_CLAIM,
        bucketCapacity: BUCKET_CAPACITY,
        paused: false,
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        jettonWallet = await blockchain.treasury('jettonWallet');

        vault = blockchain.openContract(RewardVault.createFromConfig(baseConfig(), vaultCode));
        const deployResult = await vault.sendDeploy(admin.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({ from: admin.address, to: vault.address, deploy: true, success: true });
    });

    function claimAccountFor(owner: Address): SandboxContract<ClaimAccount> {
        const addr = ClaimAccount.createFromConfig({ root: vault.address, owner }, claimAccountCode).address;
        return blockchain.openContract(ClaimAccount.createFromAddress(addr));
    }

    async function makeAttestation(
        claimant: Address,
        amount: bigint,
        opts: { nonce?: bigint; validUntil?: number; magic?: number; vault?: Address; signer?: ReturnType<typeof keyPairFromSeed> } = {}
    ): Promise<{ attestation: ClaimAttestation; signature: Buffer }> {
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const attestation: ClaimAttestation = {
            magic: opts.magic ?? CLAIM_ATTESTATION_MAGIC,
            vault: opts.vault ?? vault.address,
            claimant,
            amount,
            nonce: opts.nonce ?? 1n,
            validUntil: opts.validUntil ?? now + 3600,
        };
        const signer = opts.signer ?? oracle;
        const signature = sign(attestationToCell(attestation).hash(), signer.secretKey);
        return { attestation, signature };
    }

    it('deploys with resolved params and a zero/paused-by-default posture is up to the deploy script', async () => {
        expect(await vault.getAdminAddress()).toEqualAddress(admin.address);
        expect(await vault.getJettonWalletAddress()).toEqualAddress(jettonWallet.address);
        expect(await vault.getIsPaused()).toBe(false);
        expect(await vault.getCumulativeMined()).toBe(0n);
        expect(await vault.getCurrentEpochRate()).toBe(BASE_RATE);
        const bucket = await vault.getBucketState();
        expect(bucket.capacity).toBe(BUCKET_CAPACITY);
        expect(bucket.available).toBe(BUCKET_CAPACITY);
    });

    it('pays out a valid claim: jetton transfer sent, cumulativeMined + bucket + child state all update', async () => {
        const claimant = await blockchain.treasury('claimant');
        const account = claimAccountFor(claimant.address);
        const amount = 1000n * DECIMALS;
        const { attestation, signature } = await makeAttestation(claimant.address, amount, { nonce: 1n });

        const result = await vault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: vault.address, to: jettonWallet.address, success: true });

        expect(await vault.getCumulativeMined()).toBe(amount);
        const bucket = await vault.getBucketState();
        expect(bucket.available).toBe(BUCKET_CAPACITY - amount);

        expect(await account.getLastNonce()).toBe(1n);
        expect(await account.getLifetimeClaimed()).toBe(amount);
    });

    it('rejects replay of the same nonce', async () => {
        const claimant = await blockchain.treasury('claimant');
        const account = claimAccountFor(claimant.address);
        const amount = 1000n * DECIMALS;
        const first = await makeAttestation(claimant.address, amount, { nonce: 1n });
        await vault.sendClaim(claimant.getSender(), { queryId: 1n, ...first, value: toNano('0.3') });

        const replay = await makeAttestation(claimant.address, amount, { nonce: 1n });
        const result = await vault.sendClaim(claimant.getSender(), { queryId: 2n, ...replay, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({
            from: vault.address,
            to: account.address,
            success: false,
            exitCode: 407, // ERR_REPLAY
        });
    });

    it('rejects an expired attestation', async () => {
        const claimant = await blockchain.treasury('claimant');
        const account = claimAccountFor(claimant.address);
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const { attestation, signature } = await makeAttestation(claimant.address, 1000n * DECIMALS, { validUntil: now - 10 });

        const result = await vault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: vault.address, to: account.address, success: false, exitCode: 406 }); // ERR_EXPIRED
    });

    it('rejects a signature from the wrong key', async () => {
        const claimant = await blockchain.treasury('claimant');
        const account = claimAccountFor(claimant.address);
        const { attestation, signature } = await makeAttestation(claimant.address, 1000n * DECIMALS, { signer: wrongOracle });

        const result = await vault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: vault.address, to: account.address, success: false, exitCode: 405 }); // ERR_BAD_SIGNATURE
    });

    it('rejects an attestation naming the wrong vault (domain separation)', async () => {
        const claimant = await blockchain.treasury('claimant');
        const account = claimAccountFor(claimant.address);
        const otherVault = await blockchain.treasury('otherVault');
        const { attestation, signature } = await makeAttestation(claimant.address, 1000n * DECIMALS, { vault: otherVault.address });

        const result = await vault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: vault.address, to: account.address, success: false, exitCode: 405 }); // ERR_BAD_SIGNATURE
    });

    it('rejects a claim above maxPerClaim even with a valid signature', async () => {
        const claimant = await blockchain.treasury('claimant');
        const account = claimAccountFor(claimant.address);
        const tooMuch = MAX_PER_CLAIM + 1n;
        const { attestation, signature } = await makeAttestation(claimant.address, tooMuch);

        const result = await vault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: vault.address, to: account.address, success: false, exitCode: 404 }); // ERR_CAP_EXCEEDED
    });

    it('rejects a claim above the per-wallet elapsed-time bound, isolated from maxPerClaim', async () => {
        // Deploy a second vault with a huge maxPerClaim so only the elapsed-time formula binds.
        const bigLimitVault = blockchain.openContract(
            RewardVault.createFromConfig({ ...baseConfig(), maxPerClaim: 10_000_000_000n * DECIMALS }, vaultCode)
        );
        await bigLimitVault.sendDeploy(admin.getSender(), toNano('0.05'));

        const claimant = await blockchain.treasury('claimant');
        const accountAddr = ClaimAccount.createFromConfig({ root: bigLimitVault.address, owner: claimant.address }, claimAccountCode).address;
        const account = blockchain.openContract(ClaimAccount.createFromAddress(accountAddr));

        // Fresh account gets a 14-day backlog allowance: 14*24*CAPPED_CEILING is the max.
        const windowMax = 14n * 24n * CAPPED_CEILING;
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const attestation: ClaimAttestation = {
            magic: CLAIM_ATTESTATION_MAGIC,
            vault: bigLimitVault.address,
            claimant: claimant.address,
            amount: windowMax + CAPPED_CEILING, // one hour's worth over the ceiling
            nonce: 1n,
            validUntil: now + 3600,
        };
        const signature = signAttestation(attestation, oracle.secretKey);

        const result = await bigLimitVault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: bigLimitVault.address, to: account.address, success: false, exitCode: 404 }); // ERR_CAP_EXCEEDED
    });

    it('exhausts the bucket and rejects further claims with ERR_BUSY, without touching the 9B cap', async () => {
        const smallBucketVault = blockchain.openContract(
            RewardVault.createFromConfig(
                { ...baseConfig(), maxPerClaim: 1_000_000_000n * DECIMALS, bucketCapacity: 1000n * DECIMALS, bucketAvailable: 1000n * DECIMALS },
                vaultCode
            )
        );
        await smallBucketVault.sendDeploy(admin.getSender(), toNano('0.05'));

        const claimant = await blockchain.treasury('claimant');
        const accountAddr = ClaimAccount.createFromConfig({ root: smallBucketVault.address, owner: claimant.address }, claimAccountCode).address;
        const account = blockchain.openContract(ClaimAccount.createFromAddress(accountAddr));

        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const attestation: ClaimAttestation = {
            magic: CLAIM_ATTESTATION_MAGIC,
            vault: smallBucketVault.address,
            claimant: claimant.address,
            amount: 1000n * DECIMALS + 1n, // 1 unit over the tiny bucket capacity
            nonce: 1n,
            validUntil: now + 3600,
        };
        const signature = signAttestation(attestation, oracle.secretKey);

        const result = await smallBucketVault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: smallBucketVault.address, to: account.address, success: true });
        expect(result.transactions).toHaveTransaction({ from: account.address, to: smallBucketVault.address, success: false, exitCode: 409 }); // ERR_BUSY
        // child already committed nonce/lastClaimTime (deliberately not rewound) but lifetimeClaimed rolls back
        expect(await account.getLastNonce()).toBe(1n);
        expect(await account.getLifetimeClaimed()).toBe(0n);
    });

    it('enforces the 9B lifetime cap regardless of bucket/rate', async () => {
        const nearCapVault = blockchain.openContract(
            RewardVault.createFromConfig(
                {
                    ...baseConfig(),
                    maxPerClaim: 1_000_000_000n * DECIMALS,
                    bucketCapacity: 1_000_000_000n * DECIMALS,
                    cumulativeMined: 9_000_000_000n * DECIMALS - 500n * DECIMALS,
                },
                vaultCode
            )
        );
        await nearCapVault.sendDeploy(admin.getSender(), toNano('0.05'));

        const claimant = await blockchain.treasury('claimant');
        const accountAddr = ClaimAccount.createFromConfig({ root: nearCapVault.address, owner: claimant.address }, claimAccountCode).address;
        const account = blockchain.openContract(ClaimAccount.createFromAddress(accountAddr));

        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const attestation: ClaimAttestation = {
            magic: CLAIM_ATTESTATION_MAGIC,
            vault: nearCapVault.address,
            claimant: claimant.address,
            amount: 1000n * DECIMALS, // more than the 500 remaining
            nonce: 1n,
            validUntil: now + 3600,
        };
        const signature = signAttestation(attestation, oracle.secretKey);

        const result = await nearCapVault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });

        expect(result.transactions).toHaveTransaction({ from: nearCapVault.address, to: account.address, success: true });
        expect(result.transactions).toHaveTransaction({ from: account.address, to: nearCapVault.address, success: false, exitCode: 404 }); // ERR_CAP_EXCEEDED
        expect(await nearCapVault.getCumulativeMined()).toBe(9_000_000_000n * DECIMALS - 500n * DECIMALS); // unchanged
    });

    it('blocks claims while paused, and only the admin can pause', async () => {
        const claimant = await blockchain.treasury('claimant');
        const notAdmin = await blockchain.treasury('notAdmin');

        const bad = await vault.sendSetPaused(notAdmin.getSender(), { paused: true, value: toNano('0.05') });
        expect(bad.transactions).toHaveTransaction({ from: notAdmin.address, to: vault.address, success: false, exitCode: 401 });

        await vault.sendSetPaused(admin.getSender(), { paused: true, value: toNano('0.05') });
        expect(await vault.getIsPaused()).toBe(true);

        const { attestation, signature } = await makeAttestation(claimant.address, 1000n * DECIMALS);
        const result = await vault.sendClaim(claimant.getSender(), { queryId: 1n, attestation, signature, value: toNano('0.3') });
        expect(result.transactions).toHaveTransaction({ from: claimant.address, to: vault.address, success: false, exitCode: 408 }); // ERR_PAUSED
    });

    it('only the admin can rotate the signer key or set the jetton wallet', async () => {
        const notAdmin = await blockchain.treasury('notAdmin');
        const newKey = keyPairFromSeed(Buffer.alloc(32, 3));

        const bad = await vault.sendSetSignerKey(notAdmin.getSender(), { signerKey: BigInt('0x' + newKey.publicKey.toString('hex')), value: toNano('0.05') });
        expect(bad.transactions).toHaveTransaction({ from: notAdmin.address, to: vault.address, success: false, exitCode: 401 });

        await vault.sendSetSignerKey(admin.getSender(), { signerKey: BigInt('0x' + newKey.publicKey.toString('hex')), value: toNano('0.05') });
        expect(await vault.getSignerKey()).toBe(BigInt('0x' + newKey.publicKey.toString('hex')));

        const newWallet = await blockchain.treasury('newJettonWallet');
        const badWallet = await vault.sendSetJettonWallet(notAdmin.getSender(), { jettonWallet: newWallet.address, value: toNano('0.05') });
        expect(badWallet.transactions).toHaveTransaction({ from: notAdmin.address, to: vault.address, success: false, exitCode: 401 });

        await vault.sendSetJettonWallet(admin.getSender(), { jettonWallet: newWallet.address, value: toNano('0.05') });
        expect(await vault.getJettonWalletAddress()).toEqualAddress(newWallet.address);
    });

    it('timelocks raising bucketCapacity/maxPerClaim: cannot apply before the delay, can after', async () => {
        const newCapacity = BUCKET_CAPACITY * 2n;
        const newMaxPerClaim = MAX_PER_CLAIM * 2n;

        const notAdmin = await blockchain.treasury('notAdmin');
        const badPropose = await vault.sendProposeLimits(notAdmin.getSender(), { bucketCapacity: newCapacity, maxPerClaim: newMaxPerClaim, value: toNano('0.05') });
        expect(badPropose.transactions).toHaveTransaction({ from: notAdmin.address, to: vault.address, success: false, exitCode: 401 });

        await vault.sendProposeLimits(admin.getSender(), { bucketCapacity: newCapacity, maxPerClaim: newMaxPerClaim, value: toNano('0.05') });

        const tooEarly = await vault.sendApplyLimits(admin.getSender(), { value: toNano('0.05') });
        expect(tooEarly.transactions).toHaveTransaction({ from: admin.address, to: vault.address, success: false, exitCode: 409 }); // ERR_BUSY

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 172800 + 10;

        await vault.sendApplyLimits(admin.getSender(), { value: toNano('0.05') });
        expect(await vault.getMaxPerClaim()).toBe(newMaxPerClaim);
        const bucket = await vault.getBucketState();
        expect(bucket.capacity).toBe(newCapacity);
    });

    it('claimAccountAddressOf matches the address a real claim deploys to', async () => {
        const claimant = await blockchain.treasury('claimant');
        const predicted = await vault.getClaimAccountAddressOf(claimant.address);
        expect(predicted).toEqualAddress(claimAccountFor(claimant.address).address);
    });
});
