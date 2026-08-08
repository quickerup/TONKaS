import { toNano } from '@ton/core';
import { LiquidityLocker } from '../wrappers/LiquidityLocker';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const liquidityLocker = provider.open(LiquidityLocker.createFromConfig({}, await compile('LiquidityLocker')));

    await liquidityLocker.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(liquidityLocker.address);
}
