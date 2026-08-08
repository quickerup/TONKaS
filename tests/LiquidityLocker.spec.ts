import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { LiquidityLocker } from '../wrappers/LiquidityLocker';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

jest.setTimeout(30000);

describe('LiquidityLocker', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('LiquidityLocker');
    });

    let blockchain: Blockchain;
    let sender: SandboxContract<TreasuryContract>;
    let locker: SandboxContract<LiquidityLocker>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        sender = await blockchain.treasury('sender');

        locker = blockchain.openContract(LiquidityLocker.createFromConfig({}, code));
        const deployResult = await locker.sendDeploy(sender.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({ from: sender.address, to: locker.address, deploy: true, success: true });
    });

    // The whole anti-rug claim rests on this: no matter what arrives, nothing leaves. Checked
    // against a spread of message shapes, not just the happy path — a real jetton
    // transfer_notification, a standard jetton `transfer` request masquerading as an attempt to
    // move funds back out, an arbitrary/garbage opcode, and an empty body.
    async function expectNoOutgoingMessages(body: Cell, value = toNano('1')) {
        const before = (await blockchain.getContract(locker.address)).balance;

        const result = await sender.send({ to: locker.address, value, body });

        expect(result.transactions).toHaveTransaction({ from: sender.address, to: locker.address, success: true, outMessagesCount: 0 });

        const after = (await blockchain.getContract(locker.address)).balance;
        expect(after).toBeGreaterThan(before); // the value was actually kept, not bounced back
    }

    it('deploys and reports the marker get-method', async () => {
        expect(await locker.getIsLpLocker()).toBe(true);
    });

    it('keeps the value and sends nothing back for a real-shaped jetton transfer_notification', async () => {
        const depositor = await blockchain.treasury('depositor');
        const body = beginCell()
            .storeUint(0x7362d09c, 32) // transfer_notification
            .storeUint(1n, 64) // queryId
            .storeCoins(toNano('1000')) // amount
            .storeAddress(depositor.address) // sender
            .storeUint(0, 1) // no forward payload ref
            .endCell();
        await expectNoOutgoingMessages(body);
    });

    it('does nothing with a message shaped like a jetton transfer request (an attempted withdrawal)', async () => {
        const attacker = await blockchain.treasury('attacker');
        const body = beginCell()
            .storeUint(0x0f8a7ea5, 32) // jetton transfer opcode
            .storeUint(1n, 64)
            .storeCoins(toNano('1000'))
            .storeAddress(attacker.address) // destination — where an attacker would want funds sent
            .storeAddress(attacker.address) // response destination
            .storeUint(0, 1) // no custom payload
            .storeCoins(0) // forward ton amount
            .storeUint(0, 1) // no forward payload ref
            .endCell();
        await expectNoOutgoingMessages(body);
    });

    it('does nothing with an arbitrary/garbage opcode', async () => {
        const body = beginCell().storeUint(0xdeadbeef, 32).storeUint(123456789n, 64).endCell();
        await expectNoOutgoingMessages(body);
    });

    it('does nothing with an empty body', async () => {
        await expectNoOutgoingMessages(beginCell().endCell());
    });

    it('accepts deposits from many different senders with no interaction between them', async () => {
        const depositors = await Promise.all([1, 2, 3].map((i) => blockchain.treasury(`depositor${i}`)));
        const before = (await blockchain.getContract(locker.address)).balance;

        for (const depositor of depositors) {
            const result = await depositor.send({ to: locker.address, value: toNano('2'), body: beginCell().endCell() });
            expect(result.transactions).toHaveTransaction({ from: depositor.address, to: locker.address, success: true, outMessagesCount: 0 });
        }

        const after = (await blockchain.getContract(locker.address)).balance;
        expect(after - before).toBeGreaterThanOrEqual(toNano('5.9')); // ~3 * 2 TON, minus gas
    });
});
