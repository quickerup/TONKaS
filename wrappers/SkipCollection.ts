import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { sign } from '@ton/crypto';

// Must mirror SkipCollection.tolk's offchainContent() exactly (TEP-64 off-chain tag 0x01 + URI).
export function offchainContent(uri: string): Cell {
    return beginCell().storeUint(1, 8).storeStringTail(uri).endCell();
}

export const REFERRAL_ATTESTATION_MAGIC = 0x52464d31; // "RFM1" — must match constants.tolk, distinct from CLAIM_ATTESTATION_MAGIC

export type ReferralAttestation = {
    magic: number;
    collection: Address;
    claimant: Address;
    nonce: bigint;
    validUntil: number;
};

// Must mirror constants.tolk's ReferralAttestation auto-serialization field order exactly.
export function referralAttestationToCell(att: ReferralAttestation): Cell {
    return beginCell()
        .storeUint(att.magic, 32)
        .storeAddress(att.collection)
        .storeAddress(att.claimant)
        .storeUint(att.nonce, 64)
        .storeUint(att.validUntil, 32)
        .endCell();
}

export function referralSignatureToCell(signature: Buffer): Cell {
    if (signature.length !== 64) throw new Error('Ed25519 signature must be 64 bytes');
    return beginCell().storeBuffer(signature).endCell();
}

// The oracle's off-chain signing step for a referral claim — same key as RewardVault's oracle,
// but a structurally distinct signed payload (different magic + `collection` not `vault`),
// so a Vault-style ClaimAttestation signature can never verify here. See constants.tolk.
export function signReferralAttestation(att: ReferralAttestation, oracleSecretKey: Buffer): Buffer {
    const hash = referralAttestationToCell(att).hash();
    return sign(hash, oracleSecretKey);
}

export type SkipCollectionConfig = {
    admin: Address;
    router: Address;
    signerKey: bigint;
    itemCode: Cell;
    referralAccountCode: Cell;
    collectionContent: Cell;
    content24h: Cell;
    contentForever: Cell;
    paused?: boolean;
    nextItemIndex?: bigint;
    pendingForward?: bigint;
    freeMintBucketCapacity?: number;
    freeMintBucketAvailable?: number;
    lastFreeMintRefillAt?: number;
    pendingFreeMintBucketCapacity?: number;
    pendingEffectiveAt?: number;
};

// Must mirror SkipCollection.tolk's CollectionStorage/CodeCell/ContentCell/EconomicsCell
// .toCell() exactly.
export function skipCollectionConfigToCell(config: SkipCollectionConfig): Cell {
    const codeCell = beginCell().storeRef(config.itemCode).storeRef(config.referralAccountCode).endCell();
    const contentCell = beginCell()
        .storeRef(config.collectionContent)
        .storeRef(config.content24h)
        .storeRef(config.contentForever)
        .endCell();
    const economicsCell = beginCell()
        .storeUint(config.nextItemIndex ?? 0n, 64)
        .storeCoins(config.pendingForward ?? 0n)
        .storeUint(config.freeMintBucketCapacity ?? 0, 16)
        .storeUint(config.freeMintBucketAvailable ?? config.freeMintBucketCapacity ?? 0, 16)
        .storeUint(config.lastFreeMintRefillAt ?? 0, 32)
        .storeUint(config.pendingFreeMintBucketCapacity ?? 0, 16)
        .storeUint(config.pendingEffectiveAt ?? 0, 32)
        .endCell();

    return beginCell()
        .storeAddress(config.admin)
        .storeAddress(config.router)
        .storeUint(config.signerKey, 256)
        .storeBit(config.paused ?? false)
        .storeRef(codeCell)
        .storeRef(contentCell)
        .storeRef(economicsCell)
        .endCell();
}

export const OP_PAID_MINT = 0x80005301;
export const OP_REFERRAL_CLAIM = 0x80005302;
export const OP_SET_ROUTER = 0x80005303;
export const OP_SET_SIGNER_KEY = 0x80005304;
export const OP_SET_PAUSED = 0x80005305;
export const OP_PROPOSE_LIMITS = 0x80005306;
export const OP_APPLY_LIMITS = 0x80005307;
export const OP_RETRY_FORWARD = 0x80005308;
export const OP_SET_CONTENT = 0x8000530d;

export const TIER_24H_SKIP = 0;
export const TIER_FOREVER = 1;

export class SkipCollection implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new SkipCollection(address);
    }

    static createFromConfig(config: SkipCollectionConfig, code: Cell, workchain = 0) {
        const data = skipCollectionConfigToCell(config);
        const init = { code, data };
        return new SkipCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendPaidMint(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; tier: number; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_PAID_MINT, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeUint(opts.tier, 8)
                .endCell(),
        });
    }

    async sendReferralClaim(
        provider: ContractProvider,
        via: Sender,
        opts: { queryId?: bigint; attestationCell: Cell; signatureCell: Cell; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_REFERRAL_CLAIM, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeRef(opts.attestationCell)
                .storeRef(opts.signatureCell)
                .endCell(),
        });
    }

    async sendSetRouter(provider: ContractProvider, via: Sender, opts: { router: Address; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_ROUTER, 32).storeAddress(opts.router).endCell(),
        });
    }

    async sendSetSignerKey(provider: ContractProvider, via: Sender, opts: { signerKey: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_SIGNER_KEY, 32).storeUint(opts.signerKey, 256).endCell(),
        });
    }

    async sendSetPaused(provider: ContractProvider, via: Sender, opts: { paused: boolean; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_PAUSED, 32).storeBit(opts.paused).endCell(),
        });
    }

    async sendSetContent(
        provider: ContractProvider,
        via: Sender,
        opts: { collectionContent: Cell; content24h: Cell; contentForever: Cell; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_SET_CONTENT, 32)
                .storeRef(opts.collectionContent)
                .storeRef(opts.content24h)
                .storeRef(opts.contentForever)
                .endCell(),
        });
    }

    async sendProposeLimits(provider: ContractProvider, via: Sender, opts: { freeMintBucketCapacity: number; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_PROPOSE_LIMITS, 32).storeUint(opts.freeMintBucketCapacity, 16).endCell(),
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

    async sendRetryForward(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_RETRY_FORWARD, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .endCell(),
        });
    }

    async getCollectionData(provider: ContractProvider): Promise<{ nextItemIndex: bigint; collectionContent: Cell; admin: Address }> {
        const result = await provider.get('get_collection_data', []);
        return {
            nextItemIndex: result.stack.readBigNumber(),
            collectionContent: result.stack.readCell(),
            admin: result.stack.readAddress(),
        };
    }

    async getNftAddressByIndex(provider: ContractProvider, index: bigint): Promise<Address> {
        const result = await provider.get('get_nft_address_by_index', [{ type: 'int', value: index }]);
        return result.stack.readAddress();
    }

    async getRoyaltyParams(provider: ContractProvider): Promise<{ numerator: bigint; denominator: bigint; destination: Address }> {
        const result = await provider.get('royalty_params', []);
        return {
            numerator: result.stack.readBigNumber(),
            denominator: result.stack.readBigNumber(),
            destination: result.stack.readAddress(),
        };
    }

    async getRouterAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('routerAddress', []);
        return result.stack.readAddress();
    }

    async getAdminAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('adminAddress', []);
        return result.stack.readAddress();
    }

    async getSignerKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('signerKey', []);
        return result.stack.readBigNumber();
    }

    async getIsPaused(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('isPaused', []);
        return result.stack.readNumber() !== 0;
    }

    async getFreeMintBucketState(provider: ContractProvider): Promise<{ capacity: number; available: number; lastRefillAt: number }> {
        const result = await provider.get('freeMintBucketState', []);
        return {
            capacity: result.stack.readNumber(),
            available: result.stack.readNumber(),
            lastRefillAt: result.stack.readNumber(),
        };
    }

    async getPendingLimits(provider: ContractProvider): Promise<{ capacity: number; effectiveAt: number }> {
        const result = await provider.get('pendingLimits', []);
        return { capacity: result.stack.readNumber(), effectiveAt: result.stack.readNumber() };
    }

    async getReferralAccountAddressOf(provider: ContractProvider, owner: Address): Promise<Address> {
        const result = await provider.get('referralAccountAddressOf', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return result.stack.readAddress();
    }

    async getNextItemIndex(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('nextItemIndex', []);
        return result.stack.readBigNumber();
    }
}
