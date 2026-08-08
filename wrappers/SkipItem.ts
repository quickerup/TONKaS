import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type SkipItemConfig = {
    collection: Address;
    index: bigint;
};

// Must mirror SkipItem.tolk's blankItemData() exactly — the ONLY form used for deploy/address
// derivation. Owner/tier/content are set afterward via Init, not via config; see the
// "why item address can't depend on owner" comment in SkipItem.tolk / SkipCollection.tolk.
export function skipItemBlankDataToCell(config: SkipItemConfig): Cell {
    return beginCell()
        .storeUint(config.index, 64)
        .storeAddress(config.collection)
        .storeBit(false) // initialized
        .storeAddress(config.collection) // owner placeholder
        .storeUint(0, 8) // tier placeholder
        .storeUint(0, 32) // activatedAt
        .storeRef(beginCell().endCell())
        .endCell();
}

export const OP_TRANSFER = 0x5fcc3d14;
export const OP_GET_STATIC_DATA = 0x2fcb26a2;
export const OP_ACTIVATE = 0x8000530f;

export class SkipItem implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new SkipItem(address);
    }

    static createFromConfig(config: SkipItemConfig, code: Cell, workchain = 0) {
        const data = skipItemBlankDataToCell(config);
        const init = { code, data };
        return new SkipItem(contractAddress(workchain, init), init);
    }

    async sendTransfer(
        provider: ContractProvider,
        via: Sender,
        opts: {
            queryId?: bigint;
            newOwner: Address;
            responseDestination?: Address | null;
            forwardAmount?: bigint;
            forwardPayload?: Cell;
            value: bigint;
        }
    ) {
        const body = beginCell()
            .storeUint(OP_TRANSFER, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeAddress(opts.newOwner)
            .storeAddress(opts.responseDestination ?? null)
            .storeMaybeRef(null) // customPayload
            .storeCoins(opts.forwardAmount ?? 0n)
            .storeSlice((opts.forwardPayload ?? beginCell().endCell()).beginParse())
            .endCell();
        await provider.internal(via, { value: opts.value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    async sendActivate(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_ACTIVATE, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .endCell(),
        });
    }

    async getNftData(
        provider: ContractProvider
    ): Promise<{ initialized: boolean; index: bigint; collection: Address; owner: Address; content: Cell }> {
        const result = await provider.get('get_nft_data', []);
        return {
            initialized: result.stack.readBoolean(),
            index: result.stack.readBigNumber(),
            collection: result.stack.readAddress(),
            owner: result.stack.readAddress(),
            content: result.stack.readCell(),
        };
    }

    async getActivationState(provider: ContractProvider): Promise<{ tier: number; activatedAt: number }> {
        const result = await provider.get('activationState', []);
        return { tier: result.stack.readNumber(), activatedAt: result.stack.readNumber() };
    }
}
