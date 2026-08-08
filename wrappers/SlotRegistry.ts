import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { CurveParams, storeCurveParams } from './SlotAccount';

export type { CurveParams };

export type SlotRegistryConfig = {
    admin: Address;
    router: Address;
    accountCode: Cell;
    curve: CurveParams;
    paused?: boolean;
};

// Must mirror SlotRegistry.tolk's RootStorage.toCell() exactly.
export function slotRegistryConfigToCell(config: SlotRegistryConfig): Cell {
    return beginCell()
        .storeAddress(config.admin)
        .storeAddress(config.router)
        .storeRef(config.accountCode)
        .storeRef(storeCurveParams(config.curve))
        .storeBit(config.paused ?? false)
        .endCell();
}

export const OP_BUY_SLOT = 0x80005101;
export const OP_SET_PAUSED = 0x80005103;
export const OP_SET_ROUTER = 0x80005104;

export class SlotRegistry implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new SlotRegistry(address);
    }

    static createFromConfig(config: SlotRegistryConfig, code: Cell, workchain = 0) {
        const data = slotRegistryConfigToCell(config);
        const init = { code, data };
        return new SlotRegistry(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendBuySlot(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_BUY_SLOT, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .endCell(),
        });
    }

    async sendSetPaused(provider: ContractProvider, via: Sender, opts: { paused: boolean; queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_PAUSED, 32).storeBit(opts.paused).endCell(),
        });
    }

    async sendSetRouter(provider: ContractProvider, via: Sender, opts: { router: Address; queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_ROUTER, 32).storeAddress(opts.router).endCell(),
        });
    }

    async getCurveParams(provider: ContractProvider): Promise<CurveParams> {
        const result = await provider.get('curveParams', []);
        return {
            basePrice: result.stack.readBigNumber(),
            num: result.stack.readNumber(),
            den: result.stack.readNumber(),
            maxSlots: result.stack.readNumber(),
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

    async getAccountCode(provider: ContractProvider): Promise<Cell> {
        const result = await provider.get('accountCode', []);
        return result.stack.readCell();
    }

    async getIsPaused(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('isPaused', []);
        return result.stack.readNumber() !== 0;
    }

    async getAccountAddressOf(provider: ContractProvider, owner: Address): Promise<Address> {
        const result = await provider.get('accountAddressOf', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return result.stack.readAddress();
    }
}
