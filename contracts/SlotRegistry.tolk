tolk 1.4.2

import "constants.tolk"

// Root of the sharded slot-ownership system. Holds curve params, the current
// Router address, the SlotAccount code cell, admin, and a pause flag. Holds
// NO per-wallet data — see docs/architecture.md "Sharded accounts, not
// dictionaries" and docs/tokenomics.md for resolved curve/admin values.

struct (0x80005101) BuySlot {
    queryId: uint64
}

struct (0x80005103) SetPaused {
    paused: bool
}

struct (0x80005104) SetRouter {
    router: address
}

type RootMessage = BuySlot | SetPaused | SetRouter

struct RootStorage {
    admin: address
    router: address
    accountCode: cell
    curve: CurveParams
    paused: bool
}

fun RootStorage.toCell(self): cell {
    val curveCell = beginCell()
        .storeUint(self.curve.basePrice, 128)
        .storeUint(self.curve.num, 16)
        .storeUint(self.curve.den, 16)
        .storeUint(self.curve.maxSlots, 8)
        .endCell();
    return beginCell()
        .storeAddress(self.admin)
        .storeAddress(self.router)
        .storeRef(self.accountCode)
        .storeRef(curveCell)
        .storeBool(self.paused)
        .endCell();
}

fun RootStorage.fromCell(cell: cell): RootStorage {
    var s = cell.beginParse();
    val admin = s.loadAddress();
    val router = s.loadAddress();
    val accountCode = s.loadRef();
    var c = s.loadRef().beginParse();
    val curve = CurveParams {
        basePrice: c.loadUint(128),
        num: c.loadUint(16),
        den: c.loadUint(16),
        maxSlots: c.loadUint(8),
    };
    val paused = s.loadBool();
    return RootStorage {
        admin: admin,
        router: router,
        accountCode: accountCode,
        curve: curve,
        paused: paused,
    };
}

fun RootStorage.load() {
    return RootStorage.fromCell(contract.getData())
}

fun RootStorage.save(self) {
    contract.setData(self.toCell());
}

// Must byte-for-byte match SlotAccount's own AccountStorage.toCell() initial layout
// (root, owner, extraSlots=0, pendingForward=0, totalPaid=0; router+curve in a ref) —
// the deployed address is a hash of this exact state.
fun initialAccountData(st: RootStorage, owner: address): cell {
    val extra = beginCell()
        .storeAddress(st.router)
        .storeUint(st.curve.basePrice, 128)
        .storeUint(st.curve.num, 16)
        .storeUint(st.curve.den, 16)
        .storeUint(st.curve.maxSlots, 8)
        .endCell();
    return beginCell()
        .storeAddress(contract.getAddress())
        .storeAddress(owner)
        .storeUint(0, 32)
        .storeCoins(0)
        .storeCoins(0)
        .storeRef(extra)
        .endCell();
}

fun accountDeployDest(st: RootStorage, owner: address): AutoDeployAddress {
    return {
        stateInit: {
            code: st.accountCode,
            data: initialAccountData(st, owner),
        },
    };
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy RootMessage.fromSlice(in.body);
    match (msg) {
        BuySlot => {
            val st = RootStorage.load();
            assert (!st.paused) throw ERR_PAUSED;

            val fwd = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: accountDeployDest(st, in.senderAddress),
                value: 0,
                body: BuySlotFwd {
                    queryId: msg.queryId,
                    buyer: in.senderAddress,
                    router: st.router,
                    curve: st.curve,
                },
            });
            fwd.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        SetPaused => {
            var st = RootStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.paused = msg.paused;
            st.save();
        }

        SetRouter => {
            var st = RootStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.router = msg.router;
            st.save();
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

get fun curveParams(): (int, int, int, int) {
    val curve = RootStorage.load().curve;
    return (curve.basePrice, curve.num, curve.den, curve.maxSlots);
}

get fun routerAddress(): address {
    return RootStorage.load().router;
}

get fun adminAddress(): address {
    return RootStorage.load().admin;
}

get fun accountCode(): cell {
    return RootStorage.load().accountCode;
}

get fun isPaused(): int {
    return RootStorage.load().paused as int;
}

get fun accountAddressOf(owner: address): address {
    val st = RootStorage.load();
    return accountDeployDest(st, owner).calculateAddress();
}
