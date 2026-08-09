import { Address, beginCell, storeStateInit, toNano, Cell } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { RewardVault, RewardVaultConfig } from '../wrappers/RewardVault';

const DEPLOY_VALUE = toNano('0.05');

// Real oracle from Step 0 -- see the commit that deployed worker/, and
// https://tonkas-oracle.duck47783.workers.dev/pubkey.
export const ORACLE_PUBKEY_HEX = '1ec527f9a4e266724a26d318f86804edb8451c2299627768a5aafd600aebe9e4';
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
        validUntil: Math.floor(Date.now() / 1000) + 600,
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
