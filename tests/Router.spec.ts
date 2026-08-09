import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import {
    Router,
    Quote,
    QUOTE_MAGIC,
    GAS_SKIM,
    signQuote,
    decodePtonTransfer,
    decodeJettonTransfer,
    decodeSwapPayload,
    decodeProvideLpPayload,
    PTON_OP_TON_TRANSFER,
} from '../wrappers/Router';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

jest.setTimeout(30000);

const STATE_IDLE = 0;
const STATE_SWAP = 1;
const STATE_DEPOSITING = 2;

describe('Router', () => {
    let code: Cell;
    let quoteSigner: ReturnType<typeof keyPairFromSeed>;
    let wrongSigner: ReturnType<typeof keyPairFromSeed>;

    beforeAll(async () => {
        code = await compile('Router');
        quoteSigner = keyPairFromSeed(Buffer.alloc(32, 21));
        wrongSigner = keyPairFromSeed(Buffer.alloc(32, 23));
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let locker: SandboxContract<TreasuryContract>;
    let stonfiRouter: SandboxContract<TreasuryContract>;
    let stonfiTonkasWallet: SandboxContract<TreasuryContract>;
    let ptonWallet: SandboxContract<TreasuryContract>;
    let rewardJettonWallet: SandboxContract<TreasuryContract>;
    let cranker: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;

    const baseConfig = () => ({
        admin: admin.address,
        locker: locker.address,
        stonfiRouter: stonfiRouter.address,
        stonfiTonkasWallet: stonfiTonkasWallet.address,
        ptonWallet: ptonWallet.address,
        quoteSignerKey: BigInt('0x' + quoteSigner.publicKey.toString('hex')),
        rewardJettonWallet: rewardJettonWallet.address,
        paused: false,
        minCycleValue: toNano('10'),
        minCycleInterval: 21600, // 6h
        crankBountyBps: 150, // 1.5%
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        locker = await blockchain.treasury('locker');
        stonfiRouter = await blockchain.treasury('stonfiRouter');
        stonfiTonkasWallet = await blockchain.treasury('stonfiTonkasWallet');
        ptonWallet = await blockchain.treasury('ptonWallet');
        rewardJettonWallet = await blockchain.treasury('rewardJettonWallet');
        cranker = await blockchain.treasury('cranker');

        router = blockchain.openContract(Router.createFromConfig(baseConfig(), code));
        const deployResult = await router.sendDeploy(admin.getSender(), toNano('0.5'));
        expect(deployResult.transactions).toHaveTransaction({ from: admin.address, to: router.address, deploy: true, success: true });
    });

    async function makeQuote(opts: {
        minSwapOut?: bigint;
        minLpOut?: bigint;
        validUntil?: number;
        magic?: number;
        router?: Address;
        signer?: ReturnType<typeof keyPairFromSeed>;
    } = {}): Promise<{ quote: Quote; signature: Buffer }> {
        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const quote: Quote = {
            magic: opts.magic ?? QUOTE_MAGIC,
            router: opts.router ?? router.address,
            minSwapOut: opts.minSwapOut ?? 1n,
            minLpOut: opts.minLpOut ?? 1n,
            validUntil: opts.validUntil ?? now + 900,
        };
        const signature = signQuote(quote, (opts.signer ?? quoteSigner).secretKey);
        return { quote, signature };
    }

    // --- deploy / getters ---

    it('reports deploy-time config through getters', async () => {
        expect(await router.getAdminAddress()).toEqualAddress(admin.address);
        expect(await router.getLockerAddress()).toEqualAddress(locker.address);
        const dex = await router.getDexConfig();
        expect(dex.stonfiRouter).toEqualAddress(stonfiRouter.address);
        expect(dex.stonfiTonkasWallet).toEqualAddress(stonfiTonkasWallet.address);
        expect(dex.ptonWallet).toEqualAddress(ptonWallet.address);
        expect(await router.getQuoteSignerKey()).toBe(BigInt('0x' + quoteSigner.publicKey.toString('hex')));
        expect(await router.getRewardJettonWalletAddress()).toEqualAddress(rewardJettonWallet.address);
        expect(await router.getIsPaused()).toBe(false);
        // The deploy message itself is a plain empty-body transfer, same shape as any other
        // deposit forward — so its value is correctly counted as accumulated too, not 0.
        expect(await router.getAccumulated()).toBe(toNano('0.5'));
        const state = await router.getCycleState();
        expect(state.state).toBe(STATE_IDLE);
    });

    // --- deposits ---

    it('accumulates a plain empty-body forward (SlotAccount shape)', async () => {
        const buyer = await blockchain.treasury('buyer');
        const result = await router.sendPlainDeposit(buyer.getSender(), { value: toNano('3') });
        expect(result.transactions).toHaveTransaction({ from: buyer.address, to: router.address, success: true });
        expect(await router.getAccumulated()).toBeGreaterThan(toNano('2.9'));
    });

    it('accumulates a RouterForward-tagged forward (SkipCollection shape)', async () => {
        const buyer = await blockchain.treasury('buyer');
        const result = await router.sendTaggedDeposit(buyer.getSender(), { queryId: 7n, value: toNano('5') });
        expect(result.transactions).toHaveTransaction({ from: buyer.address, to: router.address, success: true });
        expect(await router.getAccumulated()).toBeGreaterThan(toNano('4.9'));
    });

    // --- ExecuteCycle: gating ---

    it('rejects ExecuteCycle when paused', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        await router.sendSetPaused(admin.getSender(), { paused: true, value: toNano('0.05') });
        const { quote, signature } = await makeQuote();
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false });
    });

    it('rejects ExecuteCycle below threshold', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('1') }); // well under minCycleValue, and no time elapsed
        const { quote, signature } = await makeQuote();
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false });
    });

    it('does not give a fresh (never-cycled) router a time-based free pass regardless of elapsed time', async () => {
        // lastCycleAt starts at 0 (no cycle has ever run). Naively, "now - 0" is always past
        // minCycleInterval, which would let the very first cycle bypass minCycleValue on any
        // nonzero deposit — this must not happen, even after a huge time jump.
        blockchain.now = Math.floor(Date.now() / 1000) + 100000;
        const { quote, signature } = await makeQuote();
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false, exitCode: 409 });
    });

    it('rejects a quote with the wrong magic', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote({ magic: 0xdeadbeef });
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false, exitCode: 405 });
    });

    it('rejects a quote scoped to a different router (domain separation)', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const otherRouter = await blockchain.treasury('otherRouter');
        const { quote, signature } = await makeQuote({ router: otherRouter.address });
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false, exitCode: 405 });
    });

    it('rejects an expired quote', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const now = Math.floor(Date.now() / 1000);
        const { quote, signature } = await makeQuote({ validUntil: now - 10 });
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false, exitCode: 406 });
    });

    it('rejects a quote signed by the wrong key', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote({ signer: wrongSigner });
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false, exitCode: 405 });
    });

    // --- ExecuteCycle: happy path ---

    it('starts a cycle: pays the cranker bounty, halves the rest into a real STON.fi swap payload, and moves to Swap state', async () => {
        const buyer = await blockchain.treasury('buyer');
        await router.sendPlainDeposit(buyer.getSender(), { value: toNano('20') });
        const accumulatedBefore = await router.getAccumulated();

        const { quote, signature } = await makeQuote({ minSwapOut: 12345n });
        const result = await router.sendExecuteCycle(cranker.getSender(), { queryId: 99n, quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: true });

        // cranker bounty paid
        expect(result.transactions).toHaveTransaction({ from: router.address, to: cranker.address, success: true });

        // swap dispatched to the STON.fi router's own pTON wallet
        const swapTx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === ptonWallet.address.toString()
        );
        expect(swapTx).toBeDefined();
        const body = (swapTx!.inMessage as any).body as Cell;
        const decoded = decodePtonTransfer(body);
        const bountyBefore = (accumulatedBefore * 150n) / 10000n;
        const gasSkimBefore = GAS_SKIM < accumulatedBefore - bountyBefore ? GAS_SKIM : accumulatedBefore - bountyBefore;
        expect(decoded.tonAmount).toBe((accumulatedBefore - bountyBefore - gasSkimBefore) / 2n);
        expect(decoded.refundAddress).toEqualAddress(router.address);
        expect(decoded.forwardPayload).not.toBeNull();

        const swapPayload = decodeSwapPayload(decoded.forwardPayload!);
        expect(swapPayload.askJettonWallet).toEqualAddress(stonfiTonkasWallet.address);
        expect(swapPayload.refundAddress).toEqualAddress(router.address);
        expect(swapPayload.excessesAddress).toEqualAddress(router.address);
        expect(swapPayload.receiver).toEqualAddress(router.address); // Router receives the swapped TONkAS itself
        expect(swapPayload.minAskAmount).toBe(12345n);

        const state = await router.getCycleState();
        expect(state.state).toBe(STATE_SWAP);
        expect(state.activeQueryId).toBe(99n);
        expect(await router.getAccumulated()).toBe(0n);
    });

    it('retains GAS_SKIM rather than spending the full accumulated-minus-bounty on a normal-sized cycle', async () => {
        const buyer = await blockchain.treasury('buyer');
        await router.sendPlainDeposit(buyer.getSender(), { value: toNano('20') });
        const accumulatedBefore = await router.getAccumulated();
        const bounty = (accumulatedBefore * 150n) / 10000n;
        const afterBounty = accumulatedBefore - bounty;
        expect(afterBounty).toBeGreaterThan(GAS_SKIM); // sanity: this cycle is well above the skim

        const { quote, signature } = await makeQuote();
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: true });

        const swapTx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === ptonWallet.address.toString()
        );
        const decoded = decodePtonTransfer((swapTx!.inMessage as any).body as Cell);

        const naiveSwapAmount = afterBounty / 2n; // what the swap leg would be with no skim held back
        const actualCycleAmount = afterBounty - GAS_SKIM;
        expect(decoded.tonAmount).toBe(actualCycleAmount / 2n);
        expect(decoded.tonAmount).toBeLessThan(naiveSwapAmount);
    });

    it('skims only what is available, without underflow, when accumulated-minus-bounty is smaller than GAS_SKIM', async () => {
        // Get a real cycle to run first so lastCycleAt is nonzero, then let the time clause
        // (not the value clause) admit a second, much smaller cycle.
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote: bigQuote, signature: bigSig } = await makeQuote();
        await router.sendExecuteCycle(cranker.getSender(), { quote: bigQuote, signature: bigSig, value: toNano('1') });
        // Resolve that cycle back to Idle so a second ExecuteCycle is legal.
        await router.sendJettonNotify(rewardJettonWallet.getSender(), {
            amount: toNano('1000'),
            sender: stonfiRouter.address,
            value: toNano('1'),
        });
        expect((await router.getCycleState()).state).toBe(STATE_IDLE);

        const tinyDeposit = toNano('0.5'); // well under GAS_SKIM (1 TON)
        await router.sendPlainDeposit(admin.getSender(), { value: tinyDeposit });
        const accumulatedBefore = await router.getAccumulated();
        expect(accumulatedBefore).toBeLessThan(GAS_SKIM);

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 21601; // past minCycleInterval
        const { quote, signature } = await makeQuote();
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: true });

        const bounty = (accumulatedBefore * 150n) / 10000n;
        const availableAfterBounty = accumulatedBefore - bounty;

        const swapTx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === ptonWallet.address.toString()
        );
        const decoded = decodePtonTransfer((swapTx!.inMessage as any).body as Cell);
        // All of what's left after the bounty gets skimmed (min(GAS_SKIM, available) = available),
        // so cycleAmount is 0 — not negative, not throwing.
        expect(decoded.tonAmount).toBe(0n);
        expect(availableAfterBounty).toBeLessThan(GAS_SKIM);
    });

    it('SweepStrandedJettons forwards the specified amount to the Locker, callable by anyone', async () => {
        const stranger = await blockchain.treasury('stranger');
        const result = await router.sendSweepStrandedJettons(stranger.getSender(), {
            queryId: 5n,
            amount: toNano('12345'),
            value: toNano('0.5'),
        });
        expect(result.transactions).toHaveTransaction({ from: stranger.address, to: router.address, success: true });

        const sweepTx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === rewardJettonWallet.address.toString()
        );
        expect(sweepTx).toBeDefined();
        const decoded = decodeJettonTransfer((sweepTx!.inMessage as any).body as Cell);
        expect(decoded.amount).toBe(toNano('12345'));
        expect(decoded.destination).toEqualAddress(locker.address);
    });

    it('SweepStrandedJettons does not touch Router state, even for a claimed amount that could exceed the real balance', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('5') });
        const accumulatedBefore = await router.getAccumulated();
        const stateBefore = await router.getCycleState();

        const stranger = await blockchain.treasury('stranger');
        await router.sendSweepStrandedJettons(stranger.getSender(), { amount: toNano('999999999'), value: toNano('0.5') });

        expect(await router.getAccumulated()).toBe(accumulatedBefore);
        expect((await router.getCycleState()).state).toBe(stateBefore.state);
    });

    it('pays no bounty message when crankBountyBps is 0', async () => {
        const zeroFeeConfig = { ...baseConfig(), crankBountyBps: 0 };
        const r2 = blockchain.openContract(Router.createFromConfig(zeroFeeConfig, code));
        await r2.sendDeploy(admin.getSender(), toNano('0.5'));
        await r2.sendPlainDeposit(admin.getSender(), { value: toNano('20') });

        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const quote: Quote = { magic: QUOTE_MAGIC, router: r2.address, minSwapOut: 1n, minLpOut: 1n, validUntil: now + 900 };
        const signature = signQuote(quote, quoteSigner.secretKey);

        const result = await r2.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect(result.transactions).not.toHaveTransaction({ from: r2.address, to: cranker.address });
    });

    it('rejects a second ExecuteCycle while a cycle is already in flight', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote();
        await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });

        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') }); // new deposit while mid-cycle
        const { quote: quote2, signature: sig2 } = await makeQuote();
        const result = await router.sendExecuteCycle(cranker.getSender(), { quote: quote2, signature: sig2, value: toNano('1') });
        expect(result.transactions).toHaveTransaction({ from: cranker.address, to: router.address, success: false, exitCode: 409 });
    });

    // --- swap completion -> deposit legs ---

    it('on swap completion, deposits both legs with the LP receiver set to the Locker, then returns to Idle', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote({ minLpOut: 555n });
        await router.sendExecuteCycle(cranker.getSender(), { queryId: 42n, quote, signature, value: toNano('1') });

        const pendingPairAmount = ((await router.getAccumulated()) as bigint); // 0 while in-flight; read state directly below instead
        const receivedTonkas = toNano('1000');
        const result = await router.sendJettonNotify(rewardJettonWallet.getSender(), {
            queryId: 42n,
            amount: receivedTonkas,
            sender: stonfiRouter.address,
            value: toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({ from: rewardJettonWallet.address, to: router.address, success: true });

        // TON leg -> pTON wallet, provide_lp, receiver = Locker
        const tonLegTx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === ptonWallet.address.toString()
        );
        expect(tonLegTx).toBeDefined();
        const tonLegBody = (tonLegTx!.inMessage as any).body as Cell;
        const tonLegDecoded = decodePtonTransfer(tonLegBody);
        const tonLegPayload = decodeProvideLpPayload(tonLegDecoded.forwardPayload!);
        expect(tonLegPayload.counterpartWallet).toEqualAddress(stonfiTonkasWallet.address);
        expect(tonLegPayload.receiver).toEqualAddress(locker.address);
        expect(tonLegPayload.minLpOut).toBe(555n);
        expect(tonLegPayload.bothPositive).toBe(true);

        // Jetton leg -> our own reward jetton wallet, provide_lp, receiver = Locker
        const jettonLegTx = result.transactions.find(
            (t) =>
                t.inMessage?.info.type === 'internal' &&
                t.inMessage.info.dest?.toString() === rewardJettonWallet.address.toString() &&
                t !== result.transactions[0]
        );
        expect(jettonLegTx).toBeDefined();
        const jettonLegBody = (jettonLegTx!.inMessage as any).body as Cell;
        const jettonLegDecoded = decodeJettonTransfer(jettonLegBody);
        expect(jettonLegDecoded.amount).toBe(receivedTonkas);
        expect(jettonLegDecoded.destination).toEqualAddress(stonfiRouter.address);
        const jettonLegPayload = decodeProvideLpPayload(jettonLegDecoded.forwardPayload as Cell);
        expect(jettonLegPayload.counterpartWallet).toEqualAddress(ptonWallet.address);
        expect(jettonLegPayload.receiver).toEqualAddress(locker.address);

        const state = await router.getCycleState();
        expect(state.state).toBe(STATE_IDLE);
    });

    it('ignores a JettonNotify from an unrecognized sender without erroring', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote();
        await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });

        const impostor = await blockchain.treasury('impostor');
        const result = await router.sendJettonNotify(impostor.getSender(), {
            amount: toNano('999999'),
            sender: impostor.address,
            value: toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({ from: impostor.address, to: router.address, success: true });
        // no deposit legs dispatched
        expect(result.transactions).not.toHaveTransaction({ from: router.address, to: ptonWallet.address });
        expect(await (async () => (await router.getCycleState()).state)()).toBe(STATE_SWAP); // untouched
    });

    it('ignores a JettonNotify while Idle without erroring', async () => {
        const result = await router.sendJettonNotify(rewardJettonWallet.getSender(), {
            amount: toNano('1'),
            sender: stonfiRouter.address,
            value: toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({ from: rewardJettonWallet.address, to: router.address, success: true });
        expect((await router.getCycleState()).state).toBe(STATE_IDLE);
    });

    // --- stuck cycle recovery ---

    it('rejects ResetStuckCycle before the timeout and while Idle', async () => {
        const tooEarlyWhileIdle = await router.sendResetStuckCycle(admin.getSender(), { value: toNano('0.05') });
        expect(tooEarlyWhileIdle.transactions).toHaveTransaction({ from: admin.address, to: router.address, success: false });

        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote();
        await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });

        const tooEarly = await router.sendResetStuckCycle(admin.getSender(), { value: toNano('0.05') });
        expect(tooEarly.transactions).toHaveTransaction({ from: admin.address, to: router.address, success: false });
    });

    it('lets anyone reset a genuinely stuck cycle after the timeout, restoring the held-back TON to accumulated', async () => {
        await router.sendPlainDeposit(admin.getSender(), { value: toNano('20') });
        const { quote, signature } = await makeQuote();
        await router.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 3600; // past STUCK_TIMEOUT

        const stranger = await blockchain.treasury('stranger');
        const result = await router.sendResetStuckCycle(stranger.getSender(), { value: toNano('0.05') });
        expect(result.transactions).toHaveTransaction({ from: stranger.address, to: router.address, success: true });

        expect((await router.getCycleState()).state).toBe(STATE_IDLE);
        expect(await router.getAccumulated()).toBeGreaterThan(0n); // the paired TON came back
    });

    // --- real bounce recovery ---

    it('recovers from a genuine bounce on the swap leg: state returns to Idle and the TON rejoins accumulated', async () => {
        // Point ptonWallet at an address with no deployed contract — TON auto-bounces
        // messages sent with bounce=true to an uninitialized account, exercising the real
        // onBouncedMessage path rather than a hand-crafted bounce message.
        const deadAddress = Address.parse('EQD__________________________________________0vo');
        const cfg = { ...baseConfig(), ptonWallet: deadAddress };
        const r2 = blockchain.openContract(Router.createFromConfig(cfg, code));
        await r2.sendDeploy(admin.getSender(), toNano('0.5'));
        await r2.sendPlainDeposit(admin.getSender(), { value: toNano('20') });

        const now = blockchain.now ?? Math.floor(Date.now() / 1000);
        const quote: Quote = { magic: QUOTE_MAGIC, router: r2.address, minSwapOut: 1n, minLpOut: 1n, validUntil: now + 900 };
        const signature = signQuote(quote, quoteSigner.secretKey);

        const result = await r2.sendExecuteCycle(cranker.getSender(), { quote, signature, value: toNano('1') });
        expect((await r2.getCycleState()).state).toBe(STATE_IDLE); // bounce already processed within the same sandbox tick
        expect(await r2.getAccumulated()).toBeGreaterThan(0n);
    });

    // --- admin ---

    it('gates admin functions and enforces the timelock on ProposeLimits/ApplyLimits', async () => {
        const notAdmin = await blockchain.treasury('notAdmin');

        const badPause = await router.sendSetPaused(notAdmin.getSender(), { paused: true, value: toNano('0.05') });
        expect(badPause.transactions).toHaveTransaction({ from: notAdmin.address, to: router.address, success: false });
        await router.sendSetPaused(admin.getSender(), { paused: true, value: toNano('0.05') });
        expect(await router.getIsPaused()).toBe(true);
        await router.sendSetPaused(admin.getSender(), { paused: false, value: toNano('0.05') });

        const newKey = keyPairFromSeed(Buffer.alloc(32, 31));
        const badKey = await router.sendSetQuoteSignerKey(notAdmin.getSender(), {
            quoteSignerKey: BigInt('0x' + newKey.publicKey.toString('hex')),
            value: toNano('0.05'),
        });
        expect(badKey.transactions).toHaveTransaction({ from: notAdmin.address, to: router.address, success: false });
        await router.sendSetQuoteSignerKey(admin.getSender(), {
            quoteSignerKey: BigInt('0x' + newKey.publicKey.toString('hex')),
            value: toNano('0.05'),
        });
        expect(await router.getQuoteSignerKey()).toBe(BigInt('0x' + newKey.publicKey.toString('hex')));

        const newWallet = await blockchain.treasury('newRewardWallet');
        await router.sendSetRewardJettonWallet(admin.getSender(), { rewardJettonWallet: newWallet.address, value: toNano('0.05') });
        expect(await router.getRewardJettonWalletAddress()).toEqualAddress(newWallet.address);

        const badPropose = await router.sendProposeLimits(notAdmin.getSender(), {
            minCycleValue: toNano('50'),
            minCycleInterval: 3600,
            crankBountyBps: 200,
            value: toNano('0.05'),
        });
        expect(badPropose.transactions).toHaveTransaction({ from: notAdmin.address, to: router.address, success: false });

        await router.sendProposeLimits(admin.getSender(), {
            minCycleValue: toNano('50'),
            minCycleInterval: 3600,
            crankBountyBps: 200,
            value: toNano('0.05'),
        });

        const tooEarly = await router.sendApplyLimits(admin.getSender(), { value: toNano('0.05') });
        expect(tooEarly.transactions).toHaveTransaction({ from: admin.address, to: router.address, success: false });

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 172801;
        await router.sendApplyLimits(admin.getSender(), { value: toNano('0.05') });

        const limits = await router.getCycleLimits();
        expect(limits.minCycleValue).toBe(toNano('50'));
        expect(limits.minCycleInterval).toBe(3600);
        expect(limits.crankBountyBps).toBe(200);
    });

    it('has no setter at all for locker or the STON.fi/pTON addresses — immutable by construction', () => {
        expect((router as any).sendSetLocker).toBeUndefined();
        expect((router as any).sendSetDexConfig).toBeUndefined();
    });
});
