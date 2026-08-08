tolk 1.4.2

import "constants.tolk"

// One SlotAccount per wallet that has ever bought an extra slot. Deployed
// deterministically by SlotRegistry from (code, owner, root) — see
// docs/architecture.md, "Sharded accounts, not dictionaries."
//
// Slot 1 is free and implicit: a wallet with no deployed SlotAccount reads
// as exactly 1 slot. This contract only ever tracks EXTRA slots.

const MIN_ACCOUNT_RESERVE = 10000000; // 0.01 TON kept so the account never rots out of existence
// Sends use SEND_MODE_PAY_FEES_SEPARATELY so router/refund amounts land exactly as computed —
// which means forward fees are drawn from the REMAINING balance, not from those values. This
// covers the router forward + refund + external log fees with margin.
const GAS_BUFFER = 30000000; // 0.03 TON

struct (0x80005105) RetryForward {
    queryId: uint64
}

type AccountMessage = BuySlotFwd | RetryForward

struct (0x80005106) SlotBoughtLog {
    owner: address
    extraSlots: uint32
    pricePaid: coins
}

struct AccountStorage {
    root: address
    owner: address
    router: address       // last router address seen from root; used for both forwards and retries
    curve: CurveParams     // copied from root at first purchase; curve is immutable so this never drifts
    extraSlots: uint32
    pendingForward: coins  // set when a forward to router bounces; retried permissionlessly
    totalPaid: coins
}

// root+owner+extraSlots+pendingForward+totalPaid alone can approach ~810 bits worst-case
// (two full addresses plus two max-width coins values); router+curve are split into a ref
// cell so the total never risks the 1023-bit single-cell limit.
fun AccountStorage.toCell(self): cell {
    val extra = beginCell()
        .storeAddress(self.router)
        .storeUint(self.curve.basePrice, 128)
        .storeUint(self.curve.num, 16)
        .storeUint(self.curve.den, 16)
        .storeUint(self.curve.maxSlots, 8)
        .endCell();
    return beginCell()
        .storeAddress(self.root)
        .storeAddress(self.owner)
        .storeUint(self.extraSlots, 32)
        .storeCoins(self.pendingForward)
        .storeCoins(self.totalPaid)
        .storeRef(extra)
        .endCell();
}

fun AccountStorage.fromCell(cell: cell): AccountStorage {
    var s = cell.beginParse();
    val root = s.loadAddress();
    val owner = s.loadAddress();
    val extraSlots = s.loadUint(32);
    val pendingForward = s.loadCoins();
    val totalPaid = s.loadCoins();
    var e = s.loadRef().beginParse();
    val router = e.loadAddress();
    val curve = CurveParams {
        basePrice: e.loadUint(128),
        num: e.loadUint(16),
        den: e.loadUint(16),
        maxSlots: e.loadUint(8),
    };
    return AccountStorage {
        root: root,
        owner: owner,
        router: router,
        curve: curve,
        extraSlots: extraSlots,
        pendingForward: pendingForward,
        totalPaid: totalPaid,
    };
}

fun AccountStorage.load() {
    return AccountStorage.fromCell(contract.getData())
}

fun AccountStorage.save(self) {
    contract.setData(self.toCell());
}

// Bounded by curve.maxSlots (checked by the caller before this runs) — never an unbounded loop.
// Rounds up at every step so rounding never favors the buyer.
fun computePrice(curve: CurveParams, extraSlots: int): coins {
    var price: coins = curve.basePrice;
    var i = 0;
    while (i < extraSlots) {
        price = (price * curve.num + curve.den - 1) / curve.den;
        i += 1;
    }
    return price;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AccountMessage.fromSlice(in.body);
    match (msg) {
        BuySlotFwd => {
            var st = AccountStorage.load();
            assert (in.senderAddress == st.root) throw ERR_NOT_ROOT;
            assert (st.extraSlots < st.curve.maxSlots) throw ERR_CAP_EXCEEDED;

            val price = computePrice(st.curve, st.extraSlots);

            reserveGramsOnBalance(MIN_ACCOUNT_RESERVE, RESERVE_MODE_AT_MOST);

            // usable must be net of both the reserve above AND a gas buffer — price+excess get
            // sent out explicitly, and demanding the reserve (or forgetting send fees, which
            // PAY_FEES_SEPARATELY draws from the remaining balance) on top of the full incoming
            // value is "not enough Toncoin."
            val usable = in.valueCoins - MIN_ACCOUNT_RESERVE - GAS_BUFFER;
            assert (usable >= price) throw ERR_INSUFFICIENT;

            val excess = usable - price;

            st.router = msg.router;
            st.extraSlots += 1;
            st.totalPaid += price;

            val toRouter = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: price,
                dest: st.router,
            });
            toRouter.send(SEND_MODE_PAY_FEES_SEPARATELY);

            if (excess > 0) {
                val refund = createMessage({
                    bounce: BounceMode.NoBounce,
                    value: excess,
                    dest: msg.buyer,
                });
                refund.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }

            st.save();

            val log = createExternalLogMessage({
                dest: ExtOutLogBucket { topic: TOPIC_SLOT_BOUGHT },
                body: SlotBoughtLog { owner: st.owner, extraSlots: st.extraSlots, pricePaid: price },
            });
            log.send(SEND_MODE_REGULAR);
        }

        RetryForward => {
            var st = AccountStorage.load();
            if (st.pendingForward > GAS_BUFFER) {
                // GAS_BUFFER is kept back (not resent) to cover this send's own fee under
                // PAY_FEES_SEPARATELY; it stays in the account's balance rather than being lost.
                val amount = st.pendingForward - GAS_BUFFER;
                st.pendingForward = 0;
                st.save();

                reserveGramsOnBalance(MIN_ACCOUNT_RESERVE, RESERVE_MODE_AT_MOST);
                val retry = createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    value: amount,
                    dest: st.router,
                });
                retry.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

// The router forward bounced — the slot purchase itself already happened and is not reversed
// (see docs/architecture.md "Failure semantics"). Hold the value for a permissionless retry.
fun onBouncedMessage(in: InMessageBounced) {
    var st = AccountStorage.load();
    st.pendingForward += in.valueCoins;
    st.save();
}

get fun slotsOf(): int {
    return 1 + AccountStorage.load().extraSlots;
}

get fun nextPrice(): int {
    val st = AccountStorage.load();
    return computePrice(st.curve, st.extraSlots);
}

get fun totalPaid(): int {
    return AccountStorage.load().totalPaid;
}

get fun pendingForwardAmount(): int {
    return AccountStorage.load().pendingForward;
}

get fun ownerAddress(): address {
    return AccountStorage.load().owner;
}

get fun rootAddress(): address {
    return AccountStorage.load().root;
}

get fun routerAddress(): address {
    return AccountStorage.load().router;
}
