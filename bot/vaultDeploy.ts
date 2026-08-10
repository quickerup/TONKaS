import { Address, beginCell, storeStateInit, toNano, Cell } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { RewardVault, RewardVaultConfig } from '../wrappers/RewardVault';

const DEPLOY_VALUE = toNano('0.05');

// Canonical oracle identity, shared by tonkas-oracle (the Step 0 bootstrap/manual-trigger
// service) and tonkas-game-bot (the real, player-facing bot) -- both verified independently
// reporting this same pubkey via their /pubkey debug endpoints. Rotated to a fresh seed
// during the oracle-reconciliation incident: the previous value here
// (5f109dc8bd53d18f3262ed19efc0a979190cceab0f234f63998c0d23f5b4eba9) was a pubkey someone
// had precomputed for a seed that was never actually set as either worker's ORACLE_SEED
// secret, yet ended up hardcoded here and pushed on-chain via a mistaken SetSignerKey call
// -- see that incident's commit for the full trail. https://tonkas-oracle.duck47783.workers.dev/pubkey
export const ORACLE_PUBKEY_HEX = '3c1972911d1c9de74bbe66d83a42d4dc03dc8c2525be60aba93b29f1edfec1d4';
export const ORACLE_SIGNER_KEY = BigInt('0x' + ORACLE_PUBKEY_HEX);

const DECIMALS = 1_000_000_000n; // reward jetton has 9 decimals

// 1B tokens per halving epoch, base rate ~456,621 tokens/hour at epoch 0 -- see
// docs/tokenomics.md's emission schedule table. The contract computes every epoch as
// baseRate >> epoch, so only this one value is needed; the remaining epochs follow
// automatically.
export const HALVING_INTERVAL = 1_000_000_000n * DECIMALS;
export const BASE_RATE = 456621n * DECIMALS;

// Secondary flat ceiling only -- the primary bound is the per-wallet
// hoursSinceLastClaim * cappedCeiling formula computed on-chain.
export const MAX_PER_CLAIM = 10_000_000n * DECIMALS;

// PROVISIONAL, confirmed for this deploy explicitly rather than silently carried forward --
// docs/tokenomics.md flags this as an open product decision needing a real worst-case
// backlog scenario, not a guess. Deploying paused; revisit via ProposeLimits/ApplyLimits
// (48h timelock) before ever unpausing live claims against real value.
export const BUCKET_CAPACITY = 150_000_000n * DECIMALS;

export function buildVaultConfig(admin: Address, claimAccountCode: Cell): RewardVaultConfig {
    return {
        admin,
        signerKey: ORACLE_SIGNER_KEY, // real from the start -- Step 0 already exists, unlike the original placeholder-signer deploy script
        jettonWallet: admin, // placeholder -- Vault's own jetton wallet is a function of Vault's address, unknowable until after deploy; SetJettonWallet once computed
        claimAccountCode,
        halvingInterval: HALVING_INTERVAL,
        baseRate: BASE_RATE,
        maxPerClaim: MAX_PER_CLAIM,
        bucketCapacity: BUCKET_CAPACITY,
        paused: true, // stays paused until jettonWallet is set for real (and until a test claim has been exercised, per the deploy sequence)
    };
}

export function computeVaultAddress(admin: Address, vaultCode: Cell, claimAccountCode: Cell): { vault: RewardVault; address: Address } {
    const vault = RewardVault.createFromConfig(buildVaultConfig(admin, claimAccountCode), vaultCode);
    return { vault, address: vault.address };
}

export function buildVaultDeployRequest(vault: RewardVault, fromAddress: Address): SendTransactionRequest {
    if (!vault.init) throw new Error('vault.init is missing -- was it created via RewardVault.createFromConfig?');

    const stateInit = beginCell().store(storeStateInit(vault.init)).endCell();

    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: vault.address.toString(),
                amount: DEPLOY_VALUE.toString(),
                stateInit: stateInit.toBoc().toString('base64'),
                payload: beginCell().endCell().toBoc().toString('base64'),
            },
        ],
    };
}
