import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { sign } from '@ton/crypto';

export const QUOTE_MAGIC = 0x51544531; // "QTE1", must match Router.tolk

export type Quote = {
    magic: number;
    router: Address;
    minSwapOut: bigint;
    minLpOut: bigint;
    validUntil: number;
};

// Must mirror Router.tolk's Quote auto-serialization field order exactly.
export function quoteToCell(quote: Quote): Cell {
    return beginCell()
        .storeUint(quote.magic, 32)
        .storeAddress(quote.router)
        .storeCoins(quote.minSwapOut)
        .storeCoins(quote.minLpOut)
        .storeUint(quote.validUntil, 32)
        .endCell();
}

export function signatureToCell(signature: Buffer): Cell {
    if (signature.length !== 64) throw new Error('Ed25519 signature must be 64 bytes');
    return beginCell().storeBuffer(signature).endCell();
}

// The quote-signer's off-chain step: sign exactly quoteToCell(quote).hash(), matching the
// on-chain isSignatureValid(quoteCell.hash(), signature, quoteSignerKey) check byte-for-byte.
export function signQuote(quote: Quote, quoteSignerSecretKey: Buffer): Buffer {
    const hash = quoteToCell(quote).hash();
    return sign(hash, quoteSignerSecretKey);
}

export const STONFI_OP_SWAP = 0x6664de2a;
export const STONFI_OP_PROVIDE_LP = 0x37c096df;
export const PTON_OP_TON_TRANSFER = 0x01f3835d;
export const OP_JETTON_TRANSFER = 0x0f8a7ea5;
export const OP_JETTON_NOTIFY = 0x7362d09c;
export const OP_ROUTER_FORWARD = 0x80005309;

// Decodes a pTON TON_TRANSFER body (as sent by Router.tolk) back into its fields, including
// the embedded swap/provide_lp forward_payload — used by tests to assert on exactly what
// Router constructed, not just that *some* message was sent.
export function decodePtonTransfer(body: Cell) {
    const s = body.beginParse();
    const op = s.loadUint(32);
    if (op !== PTON_OP_TON_TRANSFER) throw new Error(`expected PTON_OP_TON_TRANSFER, got 0x${op.toString(16)}`);
    const queryId = s.loadUintBig(64);
    const tonAmount = s.loadCoins();
    const refundAddress = s.loadAddress();
    const hasForward = s.loadBit();
    const forwardPayload = hasForward ? s.loadRef() : null;
    return { queryId, tonAmount, refundAddress, forwardPayload };
}

export function decodeJettonTransfer(body: Cell) {
    const s = body.beginParse();
    const op = s.loadUint(32);
    if (op !== OP_JETTON_TRANSFER) throw new Error(`expected OP_JETTON_TRANSFER, got 0x${op.toString(16)}`);
    const queryId = s.loadUintBig(64);
    const amount = s.loadCoins();
    const destination = s.loadAddress();
    const responseDestination = s.loadAddressAny();
    const hasCustomPayload = s.loadBit();
    const customPayload = hasCustomPayload ? s.loadRef() : null;
    const forwardTonAmount = s.loadCoins();
    const hasForwardPayload = s.loadBit();
    const forwardPayload = hasForwardPayload ? s.loadRef() : s.asCell();
    return { queryId, amount, destination, responseDestination, customPayload, forwardTonAmount, forwardPayload };
}

export function decodeSwapPayload(payload: Cell) {
    const s = payload.beginParse();
    const op = s.loadUint(32);
    if (op !== STONFI_OP_SWAP) throw new Error(`expected STONFI_OP_SWAP, got 0x${op.toString(16)}`);
    const askJettonWallet = s.loadAddress();
    const refundAddress = s.loadAddress();
    const excessesAddress = s.loadAddress();
    const deadline = s.loadUintBig(64);
    const r = s.loadRef().beginParse();
    const minAskAmount = r.loadCoins();
    const receiver = r.loadAddress();
    return { askJettonWallet, refundAddress, excessesAddress, deadline, minAskAmount, receiver };
}

export function decodeProvideLpPayload(payload: Cell) {
    const s = payload.beginParse();
    const op = s.loadUint(32);
    if (op !== STONFI_OP_PROVIDE_LP) throw new Error(`expected STONFI_OP_PROVIDE_LP, got 0x${op.toString(16)}`);
    const counterpartWallet = s.loadAddress();
    const refundAddress = s.loadAddress();
    const excessesAddress = s.loadAddress();
    const deadline = s.loadUintBig(64);
    const r = s.loadRef().beginParse();
    const minLpOut = r.loadCoins();
    const receiver = r.loadAddress();
    const bothPositive = r.loadBit();
    return { counterpartWallet, refundAddress, excessesAddress, deadline, minLpOut, receiver, bothPositive };
}

export type RouterConfig = {
    admin: Address;
    locker: Address;
    stonfiRouter: Address;
    stonfiTonkasWallet: Address;
    ptonWallet: Address;
    quoteSignerKey: bigint;
    rewardJettonWallet: Address;
    paused?: boolean;
    accumulated?: bigint;
    minCycleValue: bigint;
    minCycleInterval: number;
    crankBountyBps: number;
    state?: number;
    activeQueryId?: bigint;
    stuckAfter?: number;
    lastCycleAt?: number;
    pendingPairAmount?: bigint;
    pendingMinLpOut?: bigint;
    pendingMinCycleValue?: bigint;
    pendingMinCycleInterval?: number;
    pendingCrankBountyBps?: number;
    pendingEffectiveAt?: number;
};

// Must mirror Router.tolk's RouterStorage.toCell() exactly.
export function routerConfigToCell(config: RouterConfig): Cell {
    const dexConfig = beginCell()
        .storeAddress(config.stonfiRouter)
        .storeAddress(config.stonfiTonkasWallet)
        .storeAddress(config.ptonWallet)
        .endCell();
    const operational = beginCell()
        .storeUint(config.quoteSignerKey, 256)
        .storeAddress(config.rewardJettonWallet)
        .storeCoins(config.accumulated ?? 0n)
        .storeCoins(config.minCycleValue)
        .storeUint(config.minCycleInterval, 32)
        .storeUint(config.crankBountyBps, 16)
        .endCell();
    const cycleRuntime = beginCell()
        .storeUint(config.activeQueryId ?? 0n, 64)
        .storeUint(config.stuckAfter ?? 0, 32)
        .storeUint(config.lastCycleAt ?? 0, 32)
        .storeCoins(config.pendingPairAmount ?? 0n)
        .storeCoins(config.pendingMinLpOut ?? 0n)
        .storeCoins(config.pendingMinCycleValue ?? 0n)
        .storeUint(config.pendingMinCycleInterval ?? 0, 32)
        .storeUint(config.pendingCrankBountyBps ?? 0, 16)
        .storeUint(config.pendingEffectiveAt ?? 0, 32)
        .endCell();

    return beginCell()
        .storeAddress(config.admin)
        .storeAddress(config.locker)
        .storeBit(config.paused ?? false)
        .storeUint(config.state ?? 0, 8)
        .storeRef(dexConfig)
        .storeRef(operational)
        .storeRef(cycleRuntime)
        .endCell();
}

export const OP_EXECUTE_CYCLE = 0x80005401;
export const OP_RESET_STUCK_CYCLE = 0x80005402;
export const OP_SET_PAUSED = 0x80005403;
export const OP_SET_QUOTE_SIGNER_KEY = 0x80005404;
export const OP_SET_REWARD_JETTON_WALLET = 0x80005405;
export const OP_PROPOSE_LIMITS = 0x80005406;
export const OP_APPLY_LIMITS = 0x80005407;

export class Router implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new Router(address);
    }

    static createFromConfig(config: RouterConfig, code: Cell, workchain = 0) {
        const data = routerConfigToCell(config);
        const init = { code, data };
        return new Router(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // Plain empty-body TON forward — matches SlotAccount's shape.
    async sendPlainDeposit(provider: ContractProvider, via: Sender, opts: { value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // RouterForward-tagged TON forward — matches SkipCollection's shape.
    async sendTaggedDeposit(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_ROUTER_FORWARD, 32).storeUint(opts.queryId ?? 0n, 64).endCell(),
        });
    }

    async sendExecuteCycle(
        provider: ContractProvider,
        via: Sender,
        opts: { queryId?: bigint; quote: Quote; signature: Buffer; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_EXECUTE_CYCLE, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeRef(quoteToCell(opts.quote))
                .storeRef(signatureToCell(opts.signature))
                .endCell(),
        });
    }

    // Simulates the STON.fi router's own jetton wallet notifying us that a swap landed —
    // i.e. what Router.tolk's rewardJettonWallet would send after receiving tokens.
    async sendJettonNotify(
        provider: ContractProvider,
        via: Sender,
        opts: { queryId?: bigint; amount: bigint; sender: Address; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_JETTON_NOTIFY, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeCoins(opts.amount)
                .storeAddress(opts.sender)
                .storeMaybeRef(null)
                .endCell(),
        });
    }

    async sendResetStuckCycle(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_RESET_STUCK_CYCLE, 32).storeUint(opts.queryId ?? 0n, 64).endCell(),
        });
    }

    async sendSetPaused(provider: ContractProvider, via: Sender, opts: { paused: boolean; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_PAUSED, 32).storeBit(opts.paused).endCell(),
        });
    }

    async sendSetQuoteSignerKey(provider: ContractProvider, via: Sender, opts: { quoteSignerKey: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_QUOTE_SIGNER_KEY, 32).storeUint(opts.quoteSignerKey, 256).endCell(),
        });
    }

    async sendSetRewardJettonWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { rewardJettonWallet: Address; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_SET_REWARD_JETTON_WALLET, 32).storeAddress(opts.rewardJettonWallet).endCell(),
        });
    }

    async sendProposeLimits(
        provider: ContractProvider,
        via: Sender,
        opts: { minCycleValue: bigint; minCycleInterval: number; crankBountyBps: number; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_PROPOSE_LIMITS, 32)
                .storeCoins(opts.minCycleValue)
                .storeUint(opts.minCycleInterval, 32)
                .storeUint(opts.crankBountyBps, 16)
                .endCell(),
        });
    }

    async sendApplyLimits(provider: ContractProvider, via: Sender, opts: { queryId?: bigint; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_APPLY_LIMITS, 32).storeUint(opts.queryId ?? 0n, 64).endCell(),
        });
    }

    async getAdminAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('adminAddress', []);
        return result.stack.readAddress();
    }

    async getLockerAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('lockerAddress', []);
        return result.stack.readAddress();
    }

    async getDexConfig(provider: ContractProvider): Promise<{ stonfiRouter: Address; stonfiTonkasWallet: Address; ptonWallet: Address }> {
        const result = await provider.get('dexConfig', []);
        return {
            stonfiRouter: result.stack.readAddress(),
            stonfiTonkasWallet: result.stack.readAddress(),
            ptonWallet: result.stack.readAddress(),
        };
    }

    async getQuoteSignerKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('quoteSignerKey', []);
        return result.stack.readBigNumber();
    }

    async getRewardJettonWalletAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('rewardJettonWalletAddress', []);
        return result.stack.readAddress();
    }

    async getIsPaused(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('isPaused', []);
        return result.stack.readNumber() !== 0;
    }

    async getAccumulated(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('accumulated', []);
        return result.stack.readBigNumber();
    }

    async getCycleLimits(provider: ContractProvider): Promise<{ minCycleValue: bigint; minCycleInterval: number; crankBountyBps: number }> {
        const result = await provider.get('cycleLimits', []);
        return {
            minCycleValue: result.stack.readBigNumber(),
            minCycleInterval: result.stack.readNumber(),
            crankBountyBps: result.stack.readNumber(),
        };
    }

    async getCycleState(provider: ContractProvider): Promise<{ state: number; activeQueryId: bigint; stuckAfter: number; lastCycleAt: number }> {
        const result = await provider.get('cycleState', []);
        return {
            state: result.stack.readNumber(),
            activeQueryId: result.stack.readBigNumber(),
            stuckAfter: result.stack.readNumber(),
            lastCycleAt: result.stack.readNumber(),
        };
    }

    async getPendingLimits(
        provider: ContractProvider
    ): Promise<{ minCycleValue: bigint; minCycleInterval: number; crankBountyBps: number; effectiveAt: number }> {
        const result = await provider.get('pendingLimits', []);
        return {
            minCycleValue: result.stack.readBigNumber(),
            minCycleInterval: result.stack.readNumber(),
            crankBountyBps: result.stack.readNumber(),
            effectiveAt: result.stack.readNumber(),
        };
    }
}
