import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type CurveParams = {
    basePrice: bigint;
    num: number;
    den: number;
    maxSlots: number;
};

export function storeCurveParams(curve: CurveParams) {
    return beginCell()
        .storeUint(curve.basePrice, 128)
        .storeUint(curve.num, 16)
        .storeUint(curve.den, 16)
        .storeUint(curve.maxSlots, 8)
        .endCell();
}

export type SlotAccountConfig = {
    root: Address;
    owner: Address;
    router: Address;
    curve: CurveParams;
    extraSlots?: number;
    pendingForward?: bigint;
    totalPaid?: bigint;
};

// Must mirror SlotAccount.tolk's AccountStorage.toCell() exactly: root, owner,
// extraSlots, pendingForward, totalPaid inline; router+curve split into a ref
// (kept there because the addresses + curve alone can approach the 1023-bit
// single-cell limit — see the comment in the .tolk source).
export function slotAccountConfigToCell(config: SlotAccountConfig): Cell {
    const extra = beginCell().storeAddress(config.router).storeSlice(storeCurveParams(config.curve).beginParse()).endCell();

    return beginCell()
        .storeAddress(config.root)
        .storeAddress(config.owner)
        .storeUint(config.extraSlots ?? 0, 32)
        .storeCoins(config.pendingForward ?? 0n)
        .storeCoins(config.totalPaid ?? 0n)
        .storeRef(extra)
        .endCell();
}

export const OP_RETRY_FORWARD = 0x80005105;

export class SlotAccount implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new SlotAccount(address);
    }

    static createFromConfig(config: SlotAccountConfig, code: Cell, workchain = 0) {
        const data = slotAccountConfigToCell(config);
        const init = { code, data };
        return new SlotAccount(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
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

    async getSlotsOf(provider: ContractProvider): Promise<number> {
        const result = await provider.get('slotsOf', []);
        return result.stack.readNumber();
    }

    async getNextPrice(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('nextPrice', []);
        return result.stack.readBigNumber();
    }

    async getTotalPaid(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('totalPaid', []);
        return result.stack.readBigNumber();
    }

    async getPendingForwardAmount(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('pendingForwardAmount', []);
        return result.stack.readBigNumber();
    }

    async getOwnerAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('ownerAddress', []);
        return result.stack.readAddress();
    }

    async getRootAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('rootAddress', []);
        return result.stack.readAddress();
    }

    async getRouterAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('routerAddress', []);
        return result.stack.readAddress();
    }
}
