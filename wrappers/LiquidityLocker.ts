import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type LiquidityLockerConfig = {
    fsmState: number;
    targetToken: Address;
    routerA: Address;
    vaultB: Address;
    swap1QueryId: bigint;
    swap2QueryId: bigint;
    reserved: bigint;
};

export function liquidityLockerConfigToCell(config: LiquidityLockerConfig): Cell {
    return beginCell()
        .storeUint(config.fsmState, 8)
        .storeAddress(config.targetToken)
        .storeAddress(config.routerA)
        .storeAddress(config.vaultB)
        .storeUint(config.swap1QueryId, 64)
        .storeUint(config.swap2QueryId, 64)
        .storeUint(config.reserved, 64)
        .endCell();
}

export class LiquidityLocker implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

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
}
