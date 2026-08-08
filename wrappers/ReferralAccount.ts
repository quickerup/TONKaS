import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider } from '@ton/core';

export type ReferralAccountConfig = {
    collection: Address;
    owner: Address;
    lastReferralNonce?: bigint;
};

// Must mirror ReferralAccount.tolk's ReferralAccountStorage.toCell() exactly.
export function referralAccountConfigToCell(config: ReferralAccountConfig): Cell {
    return beginCell()
        .storeAddress(config.collection)
        .storeAddress(config.owner)
        .storeUint(config.lastReferralNonce ?? 0n, 64)
        .endCell();
}

export class ReferralAccount implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new ReferralAccount(address);
    }

    static createFromConfig(config: ReferralAccountConfig, code: Cell, workchain = 0) {
        const data = referralAccountConfigToCell(config);
        const init = { code, data };
        return new ReferralAccount(contractAddress(workchain, init), init);
    }

    async getLastReferralNonce(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('lastReferralNonceOf', []);
        return result.stack.readBigNumber();
    }

    async getOwnerAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('ownerAddress', []);
        return result.stack.readAddress();
    }

    async getCollectionAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('collectionAddress', []);
        return result.stack.readAddress();
    }
}
