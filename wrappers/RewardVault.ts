import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { sign } from '@ton/crypto';

export const CLAIM_ATTESTATION_MAGIC = 0x52565431; // "RVT1", must match constants.tolk

export type ClaimAttestation = {
    magic: number;
    vault: Address;
    claimant: Address;
    amount: bigint;
    nonce: bigint;
    validUntil: number;
};

// Must mirror constants.tolk's ClaimAttestation auto-serialization field order exactly.
export function attestationToCell(att: ClaimAttestation): Cell {
    return beginCell()
        .storeUint(att.magic, 32)
        .storeAddress(att.vault)
        .storeAddress(att.claimant)
        .storeCoins(att.amount)
        .storeUint(att.nonce, 64)
        .storeUint(att.validUntil, 32)
        .endCell();
}

export function signatureToCell(signature: Buffer): Cell {
    if (signature.length !== 64) throw new Error('Ed25519 signature must be 64 bytes');
    return beginCell().storeBuffer(signature).endCell();
}

// The oracle's off-chain signing step: sign exactly attestationToCell(att).hash(), matching
// the on-chain isSignatureValid(attCell.hash(), signature, signerKey) check byte-for-byte.
export function signAttestation(att: ClaimAttestation, oracleSecretKey: Buffer): Buffer {
    const hash = attestationToCell(att).hash();
    return sign(hash, oracleSecretKey);
}

export type RewardVaultConfig = {
    admin: Address;
    signerKey: bigint;
    jettonWallet: Address;
    claimAccountCode: Cell;
    cumulativeMined?: bigint;
    halvingInterval: bigint;
    baseRate: bigint;
    maxPerClaim: bigint;
    bucketCapacity: bigint;
    bucketAvailable?: bigint;
    lastRefillAt?: number;
    paused?: boolean;
    pendingBucketCapacity?: bigint;
    pendingMaxPerClaim?: bigint;
    pendingEffectiveAt?: number;
};

// Must mirror RewardVault.tolk's VaultStorage.toCell() exactly.
export function rewardVaultConfigToCell(config: RewardVaultConfig): Cell {
    const extra = beginCell()
        .storeCoins(config.cumulativeMined ?? 0n)
        .storeCoins(config.halvingInterval)
        .storeCoins(config.baseRate)
        .storeCoins(config.maxPerClaim)
        .storeCoins(config.bucketCapacity)
        .storeCoins(config.bucketAvailable ?? config.bucketCapacity)
        .storeUint(config.lastRefillAt ?? 0, 32)
        .storeCoins(config.pendingBucketCapacity ?? 0n)
        .storeCoins(config.pendingMaxPerClaim ?? 0n)
        .storeUint(config.pendingEffectiveAt ?? 0, 32)
        .endCell();

    return beginCell()
        .storeAddress(config.admin)
        .storeUint(config.signerKey, 256)
        .storeAddress(config.jettonWallet)
        .storeBit(config.paused ?? false)
        .storeRef(config.claimAccountCode)
        .storeRef(extra)
        .endCell();
}

export const OP_CLAIM = 0x80005201;
export const OP_SET_SIGNER_KEY = 0x80005205;
export const OP_SET_PAUSED = 0x80005206;
export const OP_PROPOSE_LIMITS = 0x80005207;
export const OP_APPLY_LIMITS = 0x80005208;
export const OP_SET_JETTON_WALLET = 0x80005209;

export class RewardVault implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new RewardVault(address);
    }

    static createFromConfig(config: RewardVaultConfig, code: Cell, workchain = 0) {
        const data = rewardVaultConfigToCell(config);
        const init = { code, data };
        return new RewardVault(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendClaim(
        provider: ContractProvider,
        via: Sender,
        opts: { queryId?: bigint; attestation: ClaimAttestation; signature: Buffer; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_CLAIM, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeRef(attestationToCell(opts.attestation))
                .storeRef(signatureToCell(opts.signature))
                .endCell(),
        });
    }

    async sendSetSignerKey(provider: ContractProvider, via: Sender, opts: { signerKey: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_SIGNER_KEY, 32).storeUint(opts.signerKey, 256).endCell(),
        });
    }

    async sendSetJettonWallet(provider: ContractProvider, via: Sender, opts: { jettonWallet: Address; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_JETTON_WALLET, 32).storeAddress(opts.jettonWallet).endCell(),
        });
    }

    async sendSetPaused(provider: ContractProvider, via: Sender, opts: { paused: boolean; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_PAUSED, 32).storeBit(opts.paused).endCell(),
        });
    }

    async sendProposeLimits(
        provider: ContractProvider,
        via: Sender,
        opts: { bucketCapacity: bigint; maxPerClaim: bigint; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_PROPOSE_LIMITS, 32)
                .storeCoins(opts.bucketCapacity)
                .storeCoins(opts.maxPerClaim)
                .endCell(),
        });
    }

    async sendApplyLimits(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_APPLY_LIMITS, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .endCell(),
        });
    }

    async getCumulativeMined(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('cumulativeMined', []);
        return result.stack.readBigNumber();
    }

    async getCurrentEpochRate(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('currentEpochRate', []);
        return result.stack.readBigNumber();
    }

    async getBucketState(provider: ContractProvider): Promise<{ capacity: bigint; available: bigint; lastRefillAt: number }> {
        const result = await provider.get('bucketState', []);
        return {
            capacity: result.stack.readBigNumber(),
            available: result.stack.readBigNumber(),
            lastRefillAt: result.stack.readNumber(),
        };
    }

    async getSignerKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('signerKey', []);
        return result.stack.readBigNumber();
    }

    async getAdminAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('adminAddress', []);
        return result.stack.readAddress();
    }

    async getJettonWalletAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('jettonWalletAddress', []);
        return result.stack.readAddress();
    }

    async getIsPaused(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('isPaused', []);
        return result.stack.readNumber() !== 0;
    }

    async getPendingLimits(
        provider: ContractProvider
    ): Promise<{ bucketCapacity: bigint; maxPerClaim: bigint; effectiveAt: number }> {
        const result = await provider.get('pendingLimits', []);
        return {
            bucketCapacity: result.stack.readBigNumber(),
            maxPerClaim: result.stack.readBigNumber(),
            effectiveAt: result.stack.readNumber(),
        };
    }

    async getMaxPerClaim(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('maxPerClaim', []);
        return result.stack.readBigNumber();
    }

    async getClaimAccountAddressOf(provider: ContractProvider, owner: Address): Promise<Address> {
        const result = await provider.get('claimAccountAddressOf', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return result.stack.readAddress();
    }
}
