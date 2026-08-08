import { Address, toNano } from '@ton/core';
import { LiquidityLocker } from '../wrappers/LiquidityLocker';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    // Standard zero address used as placeholders for router/vault initialization
    const zeroAddress = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');

    const liquidityLocker = provider.open(
        LiquidityLocker.createFromConfig({
            fsmState: 0,
            targetToken: zeroAddress,
            routerA: zeroAddress,
            vaultB: zeroAddress,
            swap1QueryId: 0n,
            swap2QueryId: 0n,
            reserved: 0n
        }, await compile('LiquidityLocker'))
    );

    await liquidityLocker.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(liquidityLocker.address);
}
