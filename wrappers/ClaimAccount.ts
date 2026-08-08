import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider } from '@ton/core';

export type ClaimAccountConfig = {
    root: Address;
    owner: Address;
    lastNonce?: bigint;
    lastClaimTime?: number;
    lifetimeClaimed?: bigint;
};

// Must mirror ClaimAccount.tolk's ClaimAccountStorage.toCell() exactly.
export function claimAccountConfigToCell(config: ClaimAccountConfig): Cell {
    return beginCell()
        .storeAddress(config.root)
        .storeAddress(config.owner)
        .storeUint(config.lastNonce ?? 0n, 64)
        .storeUint(config.lastClaimTime ?? 0, 32)
        .storeCoins(config.lifetimeClaimed ?? 0n)
        .endCell();
}

export class ClaimAccount implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new ClaimAccount(address);
    }

    static createFromConfig(config: ClaimAccountConfig, code: Cell, workchain = 0) {
        const data = claimAccountConfigToCell(config);
        const init = { code, data };
        return new ClaimAccount(contractAddress(workchain, init), init);
    }

    async getLastNonce(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('lastNonceOf', []);
        return result.stack.readBigNumber();
    }

    async getLastClaimTime(provider: ContractProvider): Promise<number> {
        const result = await provider.get('lastClaimTimeOf', []);
        return result.stack.readNumber();
    }

    async getLifetimeClaimed(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('lifetimeClaimed', []);
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
}
