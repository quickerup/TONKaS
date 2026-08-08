import { toNano } from '@ton/core';
import { Common } from '../wrappers/Common';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const common = provider.open(
        Common.createFromConfig(
            {
                id: Math.floor(Math.random() * 10000),
                counter: 0,
            },
            await compile('Common')
        )
    );

    await common.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(common.address);

    console.log('ID', await common.getID());
}
