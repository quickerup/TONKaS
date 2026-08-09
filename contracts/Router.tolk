tolk 1.4.2

import "constants.tolk"

// Buyback-and-Lock Router — see docs/architecture.md's Router section and
// docs/tokenomics.md's "Buyback-and-Lock Router" for the resolved design and
// verified on-chain addresses this contract is built against.
//
// Every TON from a slot/NFT purchase lands here as a plain forward (either a bare
// empty-body transfer from SlotAccount, or a RouterForward-tagged transfer from
// SkipCollection — this contract accepts both; see accumulateDeposit below).
// A permissionless, signed-quote-gated ExecuteCycle then: swaps half of the batch
// for TONkAS through STON.fi, pairs the received TONkAS with the remaining TON,
// and deposits both into the STON.fi pool with the LP token routed directly to
// the Locker — the LP never touches this contract. Single venue (STON.fi only),
// LP always locked, never burned, no fee-claim function — all settled design,
// not open questions; see docs/architecture.md.
//
// This is real DEX integration: the swap and provide_lp payload layouts below are
// transcribed field-for-field from STON.fi's own dex-core-v2 and SDK source
// (ston-fi/dex-core-v2's contracts/common/op.fc, ston-fi/sdk's BaseRouterV2_1.ts
// and PtonV2_1.ts), not reverse-engineered or guessed. Sandbox tests here verify
// this contract's OWN logic — state machine, accumulation, bounce recovery,
// admin controls, and that the LP receiver is always the Locker — against a
// treasury stand-in for the STON.fi/pTON counterparties. They cannot and do not
// verify the counterparties' own behavior; that's what testnet integration
// testing against the live deployments is for (see docs/architecture.md's build
// order note), not something a local sandbox mock can substitute for.

// --- STON.fi / pTON wire format ---
// Field-for-field from dex-core-v2/contracts/common/op.fc's op::swap / op::provide_lp,
// and sdk's PtonV2_1.createTonTransferBody. These are external protocol opcodes, not
// ours to renumber, and are never received/matched by this contract — only constructed
// as ref-embedded payloads — so they're hand-built cells rather than dispatched structs.

const STONFI_OP_SWAP = 0x6664de2a;
const STONFI_OP_PROVIDE_LP = 0x37c096df;

// Builds op::swap's forward_payload: opcode + 3 addresses + deadline inline, then a ref
// with minAskAmount/receiver/gas-for-custom-payloads/maybe-refs/referral fields. We never
// use a DEX custom payload, a refund payload, or a referral (referralValue=0,
// referralAddress=addr_none — the 2-bit "00" MsgAddress variant, written directly since
// this is the one field STON.fi's own SDK passes as a literal `null` address rather than
// omitting).
fun buildSwapPayload(askJettonWallet: address, refundAddress: address, excessesAddress: address, deadline: uint64, minAskAmount: coins, receiver: address): cell {
    return beginCell()
        .storeUint(STONFI_OP_SWAP, 32)
        .storeAddress(askJettonWallet)
        .storeAddress(refundAddress)
        .storeAddress(excessesAddress)
        .storeUint(deadline, 64)
        .storeRef(
            beginCell()
                .storeCoins(minAskAmount)
                .storeAddress(receiver)
                .storeCoins(0)    // dexCustomPayloadForwardGasAmount — unused
                .storeUint(0, 1)  // dexCustomPayload: none
                .storeCoins(0)    // refundForwardGasAmount — unused
                .storeUint(0, 1)  // refundPayload: none
                .storeUint(0, 16) // referralValue: 0 — no referral partner
                .storeUint(0, 2)  // referralAddress: addr_none
                .endCell()
        )
        .endCell();
}

// Builds op::provide_lp's forward_payload. `counterpartWallet` is STON.fi's own wallet
// for the OTHER asset in the pair (what the SDK calls routerWalletAddress) — it's how the
// DEX correlates this deposit leg with its counterpart, not a destination. `receiver` is
// who gets the minted LP token: always the Locker, never this contract — see
// docs/architecture.md "LP-token policy — settled, not an open question."
fun buildProvideLpPayload(counterpartWallet: address, refundAddress: address, excessesAddress: address, deadline: uint64, minLpOut: coins, receiver: address): cell {
    return beginCell()
        .storeUint(STONFI_OP_PROVIDE_LP, 32)
        .storeAddress(counterpartWallet)
        .storeAddress(refundAddress)
        .storeAddress(excessesAddress)
        .storeUint(deadline, 64)
        .storeRef(
            beginCell()
                .storeCoins(minLpOut)
                .storeAddress(receiver)
                .storeUint(1, 1)  // bothPositive: true — this is always a real two-sided deposit
                .storeCoins(0)    // dexCustomPayloadForwardGasAmount — unused
                .storeUint(0, 1)  // dexCustomPayload: none
                .endCell()
        )
        .endCell();
}

// Standard pTON v2.1 TON_TRANSFER — wraps native TON into the swap/deposit flow by sending
// it to STON.fi's own pTON wallet (ptonWallet below), which then behaves like any other
// jetton sender from the DEX's perspective. Opcode and layout from ston-fi/sdk's
// PtonV2_1.createTonTransferBody.
struct (0x01f3835d) PtonTransfer {
    queryId: uint64
    tonAmount: coins
    refundAddress: address
    forwardPayload: RemainingBitsAndRefs
}

// `RemainingBitsAndRefs` splices the given slice's bits/refs directly into the current
// cell rather than auto-deciding ref-vs-inline (confirmed empirically: an un-wrapped
// ~900-bit swap payload overflows PtonTransfer's cell). Both pTON's forward_payload and
// TEP-74's forward_payload are `Either Cell ^Cell`, i.e. exactly a 1-bit flag plus an
// optional ref — build that shape by hand so it's always the tiny ref variant, matching
// what pTON's own SDK does unconditionally (`storeBit(true); storeRef(...)`).
fun asForwardRef(payload: cell): slice {
    return beginCell().storeUint(1, 1).storeRef(payload).endCell().beginParse();
}

// --- Router's own oracle-signed quote (slippage protection) ---
//
// The Router can't read STON.fi's pool reserves cross-contract during execution (TON
// get-methods aren't callable synchronously), so minOut/minLpOut come from a short-lived
// signed quote instead — see docs/architecture.md "Slippage — the hard constraint." This
// is a distinct key from the Vault/referral oracle key (docs/tokenomics.md: "unrelated
// decision... a compromised quote key bleeding the buyback and a compromised claim key
// draining the vault are still meant to be independent blast radii").
const QUOTE_MAGIC = 0x51544531; // "QTE1"

struct Quote {
    magic: uint32
    router: address    // domain separation, same role as ClaimAttestation.vault
    minSwapOut: coins
    minLpOut: coins
    validUntil: uint32
}

// --- Router's own operator interface ---

struct (0x80005401) ExecuteCycle {
    queryId: uint64
    quote: Cell<Quote>
    signature: Cell<Signature>
}

struct (0x80005402) ResetStuckCycle {
    queryId: uint64
}

struct (0x80005403) SetPaused {
    paused: bool
}

struct (0x80005404) SetQuoteSignerKey {
    quoteSignerKey: uint256
}

// Same chicken-and-egg as RewardVault's SetJettonWallet: this Router's own jetton wallet
// for TONkAS is a function of (jetton master, Router's address), unknowable until after
// deploy. Immediate, not timelocked — matches RewardVault's precedent exactly.
struct (0x80005405) SetRewardJettonWallet {
    rewardJettonWallet: address
}

struct (0x80005406) ProposeLimits {
    minCycleValue: coins
    minCycleInterval: uint32
    crankBountyBps: uint16
}

struct (0x80005407) ApplyLimits {
    queryId: uint64
}

type RootMessage = ExecuteCycle | ResetStuckCycle | RouterForward | JettonNotify | SetPaused | SetQuoteSignerKey | SetRewardJettonWallet | ProposeLimits | ApplyLimits

const STATE_IDLE = 0;
const STATE_SWAP = 1;
const STATE_DEPOSITING = 2;

const TIMELOCK_DELAY = 172800; // 48h — same asymmetry rule as RewardVault/SkipCollection
const STUCK_TIMEOUT = 1800;    // 30 min — generous headroom for a normal DEX round-trip;
                                 // past this, anyone can permissionlessly reset a stuck cycle
                                 // rather than the value sink freezing on one failed hop.

const MIN_ROUTER_RESERVE = 100000000; // 0.1 TON rent-exempt reserve, kept out of cycling
const SWAP_GAS = 300000000;           // 0.3 TON — pTON wrap + swap leg + notify-back headroom
const DEPOSIT_TON_GAS = 300000000;    // 0.3 TON — pTON wrap + provide_lp TON leg
const DEPOSIT_JETTON_GAS = 300000000; // 0.3 TON — jetton wallet processing + provide_lp jetton leg
// Gas constants are sized generously off STON.fi's own SDK defaults (BaseRouterV2_1's
// gasConstants), not finely tuned — exact tuning is a testnet-integration concern, not a
// sandbox-provable one; see this file's header comment.

// stonfiRouter/stonfiTonkasWallet/ptonWallet and locker are set once at deploy and have no
// setter anywhere in this file — deliberately structurally immutable, not just
// convention. A mutable "redirect where deposits/LP go" admin call would reintroduce
// exactly the kind of admin-trust surface the whitepaper's LP-token-policy disclosure
// (docs/whitepaper.md §5.5/§8.1) says doesn't exist. If STON.fi ever migrates addresses,
// that's a new Router deployment, the same "no upgrade path" philosophy as the Locker.
struct RouterStorage {
    admin: address
    locker: address
    stonfiRouter: address
    stonfiTonkasWallet: address
    ptonWallet: address
    quoteSignerKey: uint256
    rewardJettonWallet: address
    paused: bool
    accumulated: coins
    minCycleValue: coins
    minCycleInterval: uint32
    crankBountyBps: uint16
    state: uint8
    activeQueryId: uint64
    stuckAfter: uint32
    lastCycleAt: uint32
    pendingPairAmount: coins
    pendingMinLpOut: coins
    pendingMinCycleValue: coins
    pendingMinCycleInterval: uint32
    pendingCrankBountyBps: uint16
    pendingEffectiveAt: uint32
}

fun RouterStorage.toCell(self): cell {
    val dexConfig = beginCell()
        .storeAddress(self.stonfiRouter)
        .storeAddress(self.stonfiTonkasWallet)
        .storeAddress(self.ptonWallet)
        .endCell();
    val operational = beginCell()
        .storeUint(self.quoteSignerKey, 256)
        .storeAddress(self.rewardJettonWallet)
        .storeCoins(self.accumulated)
        .storeCoins(self.minCycleValue)
        .storeUint(self.minCycleInterval, 32)
        .storeUint(self.crankBountyBps, 16)
        .endCell();
    val cycleRuntime = beginCell()
        .storeUint(self.activeQueryId, 64)
        .storeUint(self.stuckAfter, 32)
        .storeUint(self.lastCycleAt, 32)
        .storeCoins(self.pendingPairAmount)
        .storeCoins(self.pendingMinLpOut)
        .storeCoins(self.pendingMinCycleValue)
        .storeUint(self.pendingMinCycleInterval, 32)
        .storeUint(self.pendingCrankBountyBps, 16)
        .storeUint(self.pendingEffectiveAt, 32)
        .endCell();
    return beginCell()
        .storeAddress(self.admin)
        .storeAddress(self.locker)
        .storeBool(self.paused)
        .storeUint(self.state, 8)
        .storeRef(dexConfig)
        .storeRef(operational)
        .storeRef(cycleRuntime)
        .endCell();
}

fun RouterStorage.fromCell(cell: cell): RouterStorage {
    var s = cell.beginParse();
    val admin = s.loadAddress();
    val locker = s.loadAddress();
    val paused = s.loadBool();
    val state = s.loadUint(8);
    var d = s.loadRef().beginParse();
    val stonfiRouter = d.loadAddress();
    val stonfiTonkasWallet = d.loadAddress();
    val ptonWallet = d.loadAddress();
    var o = s.loadRef().beginParse();
    val quoteSignerKey = o.loadUint(256);
    val rewardJettonWallet = o.loadAddress();
    val accumulated = o.loadCoins();
    val minCycleValue = o.loadCoins();
    val minCycleInterval = o.loadUint(32);
    val crankBountyBps = o.loadUint(16);
    var c = s.loadRef().beginParse();
    return RouterStorage {
        admin: admin,
        locker: locker,
        stonfiRouter: stonfiRouter,
        stonfiTonkasWallet: stonfiTonkasWallet,
        ptonWallet: ptonWallet,
        quoteSignerKey: quoteSignerKey,
        rewardJettonWallet: rewardJettonWallet,
        paused: paused,
        accumulated: accumulated,
        minCycleValue: minCycleValue,
        minCycleInterval: minCycleInterval,
        crankBountyBps: crankBountyBps,
        state: state,
        activeQueryId: c.loadUint(64),
        stuckAfter: c.loadUint(32),
        lastCycleAt: c.loadUint(32),
        pendingPairAmount: c.loadCoins(),
        pendingMinLpOut: c.loadCoins(),
        pendingMinCycleValue: c.loadCoins(),
        pendingMinCycleInterval: c.loadUint(32),
        pendingCrankBountyBps: c.loadUint(16),
        pendingEffectiveAt: c.loadUint(32),
    };
}

fun RouterStorage.load() {
    return RouterStorage.fromCell(contract.getData())
}

fun RouterStorage.save(self) {
    contract.setData(self.toCell());
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy RootMessage.fromSlice(in.body);
    match (msg) {
        // Both this and the empty-body case in `else` below are treated as deposits —
        // covers SlotAccount's bare empty-body forward and SkipCollection's
        // RouterForward-tagged one (see constants.tolk's RouterForward comment). Anyone
        // else sending plain TON here just deepens the next cycle too; that's harmless
        // by design.
        RouterForward => {
            var st = RouterStorage.load();
            st.accumulated += in.valueCoins;
            st.save();
        }

        ExecuteCycle => {
            var st = RouterStorage.load();
            assert (!st.paused) throw ERR_PAUSED;
            assert (st.state == STATE_IDLE) throw ERR_BUSY;
            assert (st.accumulated > 0) throw ERR_INSUFFICIENT;

            val quoteCell = msg.quote;
            val quote = quoteCell.load();
            val signature = msg.signature.load().bits;
            assert (quote.magic == QUOTE_MAGIC) throw ERR_BAD_SIGNATURE;
            assert (quote.router == contract.getAddress()) throw ERR_BAD_SIGNATURE;
            assert (blockchain.now() < quote.validUntil) throw ERR_EXPIRED;
            assert (isSignatureValid(quoteCell.hash(), signature as slice, st.quoteSignerKey)) throw ERR_BAD_SIGNATURE;

            // lastCycleAt == 0 means no cycle has ever run — the time clause must NOT apply
            // then (blockchain.now() - 0 is always astronomically past minCycleInterval,
            // which would let the very first cycle bypass minCycleValue on any nonzero
            // deposit). Same "special-case the never-happened-yet state" pattern as
            // ClaimAccount's lastNonce == 0 handling.
            val thresholdMet = st.accumulated >= st.minCycleValue || (st.lastCycleAt != 0 && (blockchain.now() - st.lastCycleAt) >= st.minCycleInterval);
            assert (thresholdMet) throw ERR_BUSY;

            val bounty = st.accumulated * st.crankBountyBps / 10000;
            val cycleAmount = st.accumulated - bounty;
            val swapAmount = cycleAmount / 2;
            val pairAmount = cycleAmount - swapAmount;

            st.state = STATE_SWAP;
            st.activeQueryId = msg.queryId;
            st.stuckAfter = (blockchain.now() + STUCK_TIMEOUT) as uint32;
            st.lastCycleAt = blockchain.now() as uint32;
            st.accumulated = 0;
            st.pendingPairAmount = pairAmount;
            st.pendingMinLpOut = quote.minLpOut;
            st.save();

            reserveGramsOnBalance(MIN_ROUTER_RESERVE, RESERVE_MODE_AT_MOST);

            if (bounty > 0) {
                val bountyMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    value: bounty,
                    dest: in.senderAddress,
                });
                bountyMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }

            val swapPayload = buildSwapPayload(
                st.stonfiTonkasWallet,
                contract.getAddress(),
                contract.getAddress(),
                quote.validUntil as uint64,
                quote.minSwapOut,
                contract.getAddress(),
            );
            val swapMsg = createMessage({
                bounce: BounceMode.RichBounce, // failure must return the full principal, not just 256 bits
                value: swapAmount + SWAP_GAS,
                dest: st.ptonWallet,
                body: PtonTransfer {
                    queryId: msg.queryId,
                    tonAmount: swapAmount,
                    refundAddress: contract.getAddress(),
                    forwardPayload: asForwardRef(swapPayload),
                },
            });
            swapMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        // Standard TEP-74 notification from our own registered TONkAS wallet — the swap
        // leg landing. Anything else (wrong sender, or arriving outside STATE_SWAP — e.g.
        // a refund notification from a failed jetton-side deposit leg) is accepted as a
        // no-op: the tokens are already safely in our own jetton wallet balance either
        // way, and forcing every possible refund path through this same trigger would
        // conflate "swap completed" with "some unrelated jetton arrived." See this file's
        // header comment on what sandbox tests can and can't prove here.
        JettonNotify => {
            var st = RouterStorage.load();
            if (in.senderAddress != st.rewardJettonWallet || st.state != STATE_SWAP) {
                return;
            }

            val receivedTonkas = msg.amount;
            val deadline = (blockchain.now() + STUCK_TIMEOUT) as uint64;

            st.state = STATE_DEPOSITING;
            st.save();

            reserveGramsOnBalance(MIN_ROUTER_RESERVE, RESERVE_MODE_AT_MOST);

            val tonLegPayload = buildProvideLpPayload(
                st.stonfiTonkasWallet,
                contract.getAddress(),
                contract.getAddress(),
                deadline,
                st.pendingMinLpOut,
                st.locker, // LP token goes straight to the Locker — never this contract
            );
            val tonLeg = createMessage({
                bounce: BounceMode.RichBounce,
                value: st.pendingPairAmount + DEPOSIT_TON_GAS,
                dest: st.ptonWallet,
                body: PtonTransfer {
                    queryId: st.activeQueryId,
                    tonAmount: st.pendingPairAmount,
                    refundAddress: contract.getAddress(),
                    forwardPayload: asForwardRef(tonLegPayload),
                },
            });
            tonLeg.send(SEND_MODE_PAY_FEES_SEPARATELY);

            val jettonLegPayload = buildProvideLpPayload(
                st.ptonWallet,
                contract.getAddress(),
                contract.getAddress(),
                deadline,
                st.pendingMinLpOut,
                st.locker, // same — the jetton leg's LP also goes straight to the Locker
            );
            val jettonLeg = createMessage({
                bounce: BounceMode.RichBounce,
                value: DEPOSIT_JETTON_GAS,
                dest: st.rewardJettonWallet,
                body: JettonTransfer {
                    queryId: st.activeQueryId,
                    amount: receivedTonkas,
                    destination: st.stonfiRouter,
                    responseDestination: contract.getAddress(),
                    customPayload: null,
                    forwardTonAmount: DEPOSIT_JETTON_GAS / 2,
                    forwardPayload: asForwardRef(jettonLegPayload),
                },
            });
            jettonLeg.send(SEND_MODE_PAY_FEES_SEPARATELY);

            // Both legs are dispatched; there is nothing further for this contract to do
            // for this cycle (the LP token, if the deposit succeeds, lands directly at the
            // Locker without ever passing through here). Return to Idle immediately rather
            // than waiting on an ack that may never arrive in a shape worth parsing — see
            // docs/architecture.md's Router "Cycle state machine" for why this is a
            // deliberate 3-state (not 4-state) design.
            var st2 = RouterStorage.load();
            st2.state = STATE_IDLE;
            st2.pendingPairAmount = 0;
            st2.pendingMinLpOut = 0;
            st2.save();
        }

        ResetStuckCycle => {
            var st = RouterStorage.load();
            assert (st.state != STATE_IDLE) throw ERR_BUSY;
            assert (blockchain.now() >= st.stuckAfter) throw ERR_BUSY;
            st.state = STATE_IDLE;
            st.accumulated += st.pendingPairAmount; // whatever TON was held back for pairing is still ours
            st.pendingPairAmount = 0;
            st.pendingMinLpOut = 0;
            st.save();
        }

        SetPaused => {
            var st = RouterStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.paused = msg.paused;
            st.save();
        }

        SetQuoteSignerKey => {
            var st = RouterStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.quoteSignerKey = msg.quoteSignerKey;
            st.save();
        }

        SetRewardJettonWallet => {
            var st = RouterStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.rewardJettonWallet = msg.rewardJettonWallet;
            st.save();
        }

        ProposeLimits => {
            var st = RouterStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.pendingMinCycleValue = msg.minCycleValue;
            st.pendingMinCycleInterval = msg.minCycleInterval;
            st.pendingCrankBountyBps = msg.crankBountyBps;
            st.pendingEffectiveAt = (blockchain.now() + TIMELOCK_DELAY) as uint32;
            st.save();
        }

        ApplyLimits => {
            var st = RouterStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            assert (st.pendingEffectiveAt != 0) throw ERR_BUSY;
            assert (blockchain.now() >= st.pendingEffectiveAt) throw ERR_BUSY;
            st.minCycleValue = st.pendingMinCycleValue;
            st.minCycleInterval = st.pendingMinCycleInterval;
            st.crankBountyBps = st.pendingCrankBountyBps;
            st.pendingEffectiveAt = 0;
            st.save();
        }

        else => {
            // Plain TON with an empty body — SlotAccount's forward shape. Anything else
            // unrecognized-but-nonempty is rejected rather than silently swallowed.
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
            var st = RouterStorage.load();
            st.accumulated += in.valueCoins;
            st.save();
        }
    }
}

// A bounce means this leg's TON never landed — return to Idle and fold the value straight
// back into the next cycle. Deliberately doesn't distinguish which leg bounced (swap vs.
// either provide_lp leg): by the time a provide_lp leg's bounce could arrive, state is
// already back to Idle (see JettonNotify above), so re-crediting accumulated and
// (harmlessly, redundantly) setting state to Idle is correct either way — see
// docs/architecture.md "Every leg has a bounce handler that returns the cycle to Idle."
fun onBouncedMessage(in: InMessageBounced) {
    var st = RouterStorage.load();
    st.state = STATE_IDLE;
    st.accumulated += in.valueCoins;
    st.pendingPairAmount = 0;
    st.pendingMinLpOut = 0;
    st.save();
}

get fun adminAddress(): address {
    return RouterStorage.load().admin;
}

get fun lockerAddress(): address {
    return RouterStorage.load().locker;
}

get fun dexConfig(): (address, address, address) {
    val st = RouterStorage.load();
    return (st.stonfiRouter, st.stonfiTonkasWallet, st.ptonWallet);
}

get fun quoteSignerKey(): int {
    return RouterStorage.load().quoteSignerKey;
}

get fun rewardJettonWalletAddress(): address {
    return RouterStorage.load().rewardJettonWallet;
}

get fun isPaused(): int {
    return RouterStorage.load().paused as int;
}

get fun accumulated(): int {
    return RouterStorage.load().accumulated;
}

get fun cycleLimits(): (int, int, int) {
    val st = RouterStorage.load();
    return (st.minCycleValue, st.minCycleInterval, st.crankBountyBps);
}

get fun cycleState(): (int, int, int, int) {
    val st = RouterStorage.load();
    return (st.state, st.activeQueryId, st.stuckAfter, st.lastCycleAt);
}

get fun pendingLimits(): (int, int, int, int) {
    val st = RouterStorage.load();
    return (st.pendingMinCycleValue, st.pendingMinCycleInterval, st.pendingCrankBountyBps, st.pendingEffectiveAt);
}
