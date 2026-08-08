import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

// The Locker has no storage worth configuring — see contracts/LiquidityLocker.tolk. `id` only
// exists so tests/deploys can produce distinct addresses; the real deployment can omit it.
export type LiquidityLockerConfig = {
    id?: number;
};

export function liquidityLockerConfigToCell(config: LiquidityLockerConfig): Cell {
    return beginCell().storeUint(config.id ?? 0, 32).endCell();
}

export class LiquidityLocker implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new LiquidityLocker(address);
    }

    static createFromConfig(config: LiquidityLockerConfig, code: Cell, workchain = 0) {
        const data = liquidityLockerConfigToCell(config);
        const init = { code, data };
        return new LiquidityLocker(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getIsLpLocker(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('isLpLocker', []);
        return result.stack.readNumber() === -1;
    }
}
