import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { SlotRegistry, CurveParams } from '../wrappers/SlotRegistry';
import { SlotAccount } from '../wrappers/SlotAccount';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// Mirrors the contract's own computePrice(): ceil-division at every step so
// rounding never favors the buyer. Used to compute expected prices in tests.
function expectedPrice(curve: CurveParams, extraSlots: number): bigint {
    let price = curve.basePrice;
    for (let i = 0; i < extraSlots; i++) {
        price = (price * BigInt(curve.num) + BigInt(curve.den) - 1n) / BigInt(curve.den);
    }
    return price;
}

// A message's declared `value` always arrives at its destination minus a small unavoidable
// network forward fee, even under SEND_MODE_PAY_FEES_SEPARATELY (that mode only controls
// whether the *sender's* balance additionally absorbs the fee, not whether the destination
// receives the value untouched) — so router-received checks need slack, not exact equality.
// Per-message overhead observed in sandbox is ~20-21k nanoTON; 200k gives ample margin per hop.
const FORWARD_FEE_TOLERANCE_PER_MESSAGE = 200000n;

function expectCloseToRouter(received: bigint, expected: bigint, messageCount: number) {
    const maxFee = FORWARD_FEE_TOLERANCE_PER_MESSAGE * BigInt(messageCount);
    expect(received).toBeLessThanOrEqual(expected);
    expect(expected - received).toBeLessThanOrEqual(maxFee);
}

jest.setTimeout(30000); // Tolk compiles two contracts in beforeAll; cold WASM init can exceed the 5s default

describe('SlotRegistry', () => {
    let accountCode: Cell;
    let registryCode: Cell;

    const curve: CurveParams = { basePrice: toNano('1'), num: 23, den: 20, maxSlots: 100 };

    beforeAll(async () => {
        accountCode = await compile('SlotAccount');
        registryCode = await compile('SlotRegistry');
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let router: SandboxContract<TreasuryContract>;
    let registry: SandboxContract<SlotRegistry>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        router = await blockchain.treasury('router');

        registry = blockchain.openContract(
            SlotRegistry.createFromConfig({ admin: admin.address, router: router.address, accountCode, curve }, registryCode)
        );

        const deployResult = await registry.sendDeploy(admin.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: registry.address,
            deploy: true,
            success: true,
        });
    });

    function accountFor(owner: Address): SandboxContract<SlotAccount> {
        const addr = SlotAccount.createFromConfig({ root: registry.address, owner, router: router.address, curve }, accountCode).address;
        return blockchain.openContract(SlotAccount.createFromAddress(addr));
    }

    it('deploys with the resolved curve/admin/router', async () => {
        expect(await registry.getAdminAddress()).toEqualAddress(admin.address);
        expect(await registry.getRouterAddress()).toEqualAddress(router.address);
        expect(await registry.getIsPaused()).toBe(false);

        const gotCurve = await registry.getCurveParams();
        expect(gotCurve.basePrice).toBe(curve.basePrice);
        expect(gotCurve.num).toBe(curve.num);
        expect(gotCurve.den).toBe(curve.den);
        expect(gotCurve.maxSlots).toBe(curve.maxSlots);
    });

    it('accountAddressOf matches the address a real purchase deploys to', async () => {
        const buyer = await blockchain.treasury('buyer');
        const predicted = await registry.getAccountAddressOf(buyer.address);
        expect(predicted).toEqualAddress(accountFor(buyer.address).address);
    });

    it('a wallet with no deployed SlotAccount has no on-chain get-method to call — the "slots = 1" default is an off-chain/oracle convention, not a chain query', async () => {
        const neverBought = await blockchain.treasury('neverBought');
        const account = accountFor(neverBought.address);
        await expect(account.getSlotsOf()).rejects.toBeTruthy();
    });

    it('first extra slot costs exactly basePrice and forwards it to the router', async () => {
        const buyer = await blockchain.treasury('buyer');
        const account = accountFor(buyer.address);
        const routerBalanceBefore = (await blockchain.getContract(router.address)).balance;

        const result = await registry.sendBuySlot(buyer.getSender(), { queryId: 1n, value: toNano('1.2') });

        expect(result.transactions).toHaveTransaction({
            from: registry.address,
            to: account.address,
            deploy: true,
            success: true,
        });

        const price = expectedPrice(curve, 0);
        expect(price).toBe(toNano('1'));

        expect(await account.getSlotsOf()).toBe(2); // free slot + 1 extra
        expect(await account.getTotalPaid()).toBe(price);
        expect(await account.getOwnerAddress()).toEqualAddress(buyer.address);
        expect(await account.getRootAddress()).toEqualAddress(registry.address);

        const routerBalanceAfter = (await blockchain.getContract(router.address)).balance;
        expectCloseToRouter(routerBalanceAfter - routerBalanceBefore, price, 1);
    });

    it('escalates price geometrically and rounds up at every step', async () => {
        const buyer = await blockchain.treasury('buyer');
        const account = accountFor(buyer.address);

        for (let n = 0; n < 5; n++) {
            const price = expectedPrice(curve, n);
            await registry.sendBuySlot(buyer.getSender(), { queryId: BigInt(n), value: price + toNano('0.3') });
            expect(await account.getSlotsOf()).toBe(n + 2);
            expect(await account.getNextPrice()).toBe(expectedPrice(curve, n + 1));
        }

        const totalExpected = [0, 1, 2, 3, 4].reduce((sum, n) => sum + expectedPrice(curve, n), 0n);
        expect(await account.getTotalPaid()).toBe(totalExpected);
    });

    it('refunds the excess above the quoted price', async () => {
        const buyer = await blockchain.treasury('buyer');
        const price = expectedPrice(curve, 0);
        const attached = price + toNano('0.5');

        const result = await registry.sendBuySlot(buyer.getSender(), { queryId: 1n, value: attached });
        const account = accountFor(buyer.address);

        expect(result.transactions).toHaveTransaction({
            from: account.address,
            to: buyer.address,
            success: true,
        });
        // buyer paid `attached`, got back ~0.5 TON minus gas — sanity check it's not the full amount kept
        expect(await account.getTotalPaid()).toBe(price);
    });

    it('rejects a purchase below the quoted price', async () => {
        const buyer = await blockchain.treasury('buyer');
        const price = expectedPrice(curve, 0);
        const account = accountFor(buyer.address);

        const result = await registry.sendBuySlot(buyer.getSender(), { queryId: 1n, value: price - toNano('0.5') });

        expect(result.transactions).toHaveTransaction({
            from: registry.address,
            to: account.address,
            success: false,
            exitCode: 403, // ERR_INSUFFICIENT
        });
    });

    it('blocks purchases while paused, and only the admin can pause', async () => {
        const buyer = await blockchain.treasury('buyer');
        const notAdmin = await blockchain.treasury('notAdmin');

        const badPause = await registry.sendSetPaused(notAdmin.getSender(), { paused: true, value: toNano('0.05') });
        expect(badPause.transactions).toHaveTransaction({
            from: notAdmin.address,
            to: registry.address,
            success: false,
            exitCode: 401, // ERR_NOT_OWNER
        });
        expect(await registry.getIsPaused()).toBe(false);

        await registry.sendSetPaused(admin.getSender(), { paused: true, value: toNano('0.05') });
        expect(await registry.getIsPaused()).toBe(true);

        const result = await registry.sendBuySlot(buyer.getSender(), { queryId: 1n, value: toNano('1.2') });
        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: registry.address,
            success: false,
            exitCode: 408, // ERR_PAUSED
        });

        await registry.sendSetPaused(admin.getSender(), { paused: false, value: toNano('0.05') });
        const result2 = await registry.sendBuySlot(buyer.getSender(), { queryId: 2n, value: toNano('1.2') });
        expect(result2.transactions).toHaveTransaction({ from: registry.address, to: accountFor(buyer.address).address, success: true });
    });

    it('only the admin can change the router', async () => {
        const notAdmin = await blockchain.treasury('notAdmin');
        const newRouter = await blockchain.treasury('newRouter');

        const bad = await registry.sendSetRouter(notAdmin.getSender(), { router: newRouter.address, value: toNano('0.05') });
        expect(bad.transactions).toHaveTransaction({ from: notAdmin.address, to: registry.address, success: false, exitCode: 401 });

        await registry.sendSetRouter(admin.getSender(), { router: newRouter.address, value: toNano('0.05') });
        expect(await registry.getRouterAddress()).toEqualAddress(newRouter.address);

        // a purchase after the switch forwards to the NEW router
        const buyer = await blockchain.treasury('buyer');
        const routerBalanceBefore = (await blockchain.getContract(newRouter.address)).balance;
        await registry.sendBuySlot(buyer.getSender(), { queryId: 1n, value: toNano('1.2') });
        const routerBalanceAfter = (await blockchain.getContract(newRouter.address)).balance;
        expectCloseToRouter(routerBalanceAfter - routerBalanceBefore, expectedPrice(curve, 0), 1);
    });

    it('enforces MAX_SLOTS', async () => {
        const tinyCurve: CurveParams = { basePrice: toNano('1'), num: 23, den: 20, maxSlots: 2 };
        const tinyRegistry = blockchain.openContract(
            SlotRegistry.createFromConfig({ admin: admin.address, router: router.address, accountCode, curve: tinyCurve }, registryCode)
        );
        await tinyRegistry.sendDeploy(admin.getSender(), toNano('0.05'));

        const buyer = await blockchain.treasury('capBuyer');
        const account = blockchain.openContract(
            SlotAccount.createFromAddress(
                SlotAccount.createFromConfig({ root: tinyRegistry.address, owner: buyer.address, router: router.address, curve: tinyCurve }, accountCode)
                    .address
            )
        );

        await tinyRegistry.sendBuySlot(buyer.getSender(), { queryId: 1n, value: toNano('1.2') });
        await tinyRegistry.sendBuySlot(buyer.getSender(), { queryId: 2n, value: toNano('1.2') });
        expect(await account.getSlotsOf()).toBe(3); // free + 2 extra = at maxSlots

        const overCap = await tinyRegistry.sendBuySlot(buyer.getSender(), { queryId: 3n, value: toNano('1.2') });
        expect(overCap.transactions).toHaveTransaction({
            from: tinyRegistry.address,
            to: account.address,
            success: false,
            exitCode: 404, // ERR_CAP_EXCEEDED
        });
        expect(await account.getSlotsOf()).toBe(3); // unchanged
    });

    it('sum of totalPaid across all SlotAccounts equals total TON received by the router from the Registry path', async () => {
        const buyers = await Promise.all([1, 2, 3].map((i) => blockchain.treasury(`sumBuyer${i}`)));
        const routerBalanceBefore = (await blockchain.getContract(router.address)).balance;

        let expectedTotal = 0n;
        for (const buyer of buyers) {
            for (let n = 0; n < 2; n++) {
                const price = expectedPrice(curve, n);
                expectedTotal += price;
                await registry.sendBuySlot(buyer.getSender(), { queryId: BigInt(n), value: price + toNano('0.3') });
            }
        }

        let sumTotalPaid = 0n;
        for (const buyer of buyers) {
            sumTotalPaid += await accountFor(buyer.address).getTotalPaid();
        }
        expect(sumTotalPaid).toBe(expectedTotal);

        const routerBalanceAfter = (await blockchain.getContract(router.address)).balance;
        expectCloseToRouter(routerBalanceAfter - routerBalanceBefore, expectedTotal, buyers.length * 2);
    });
});
