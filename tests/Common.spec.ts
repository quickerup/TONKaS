import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { Common } from '../wrappers/Common';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

jest.setTimeout(30000); // Tolk cold-compiles in beforeAll; can exceed the 5s default on a loaded machine

describe('Common', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('Common');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let common: SandboxContract<Common>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        common = blockchain.openContract(
            Common.createFromConfig(
                {
                    id: 0,
                    counter: 0,
                },
                code
            )
        );

        deployer = await blockchain.treasury('deployer');

        const deployResult = await common.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: common.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and common are ready to use
    });

    it('should increase counter', async () => {
        const increaseTimes = 3;
        for (let i = 0; i < increaseTimes; i++) {
            console.log(`increase ${i + 1}/${increaseTimes}`);

            const increaser = await blockchain.treasury('increaser' + i);

            const counterBefore = await common.getCounter();

            console.log('counter before increasing', counterBefore);

            const increaseBy = Math.floor(Math.random() * 100);

            console.log('increasing by', increaseBy);

            const increaseResult = await common.sendIncrease(increaser.getSender(), {
                increaseBy,
                value: toNano('0.05'),
            });

            expect(increaseResult.transactions).toHaveTransaction({
                from: increaser.address,
                to: common.address,
                success: true,
            });

            const counterAfter = await common.getCounter();

            console.log('counter after increasing', counterAfter);

            expect(counterAfter).toBe(counterBefore + increaseBy);
        }
    });

    it('should reset counter', async () => {
        const increaser = await blockchain.treasury('increaser');

        expect(await common.getCounter()).toBe(0);

        const increaseBy = 5;
        await common.sendIncrease(increaser.getSender(), {
            increaseBy,
            value: toNano('0.05'),
        });

        expect(await common.getCounter()).toBe(increaseBy);

        await common.sendReset(increaser.getSender(), {
            value: toNano('0.05'),
        });

        expect(await common.getCounter()).toBe(0);
    });
});
