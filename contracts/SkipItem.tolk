tolk 1.4.2

import "constants.tolk"

// TEP-62 NFT item, one per minted Skip. `tier` (TIER_24H_SKIP | TIER_FOREVER) lives on the
// item itself rather than splitting into two collections — see docs/tokenomics.md "Shape."
// Both tiers are fully standard-transferable (neither soulbound); Forever specifically needs
// a real secondary market, and the oracle reads holders directly off-chain via standard
// ownership, so this file must not deviate from normal TEP-62 transfer semantics anywhere.
//
// Deploy address depends ONLY on (collection, index) — never on owner/tier — matching the
// TEP-62 convention that get_nft_address_by_index(index) is computable with no other input.
// So the item deploys "blank" (initialized=false) via stateInit, and the collection's very
// first message (Init) sets owner/tier/content — same two-step shape as SlotAccount/
// ClaimAccount's deploy-then-configure, just with the ownership-independent piece split out
// because THIS address specifically has to be predictable without knowing the owner.
//
// Activation model (24h-skip only — see docs/architecture.md "The expiry problem", the
// repeatable variant of Model 2): item initializes with activatedAt=0 regardless of tier.
// The current owner can call Activate at ANY time — repeatedly, indefinitely, not just
// once — to reset activatedAt to now, like a recurring daily card-swipe rather than a
// single-use voucher. There's no one-time guard: resetting early costs the holder nothing
// and touches no shared resource, so there's no reason to restrict frequency. Forever
// ignores activatedAt entirely — always active, no interaction required. The 24h expiry
// itself is enforced off-chain by the oracle (activatedAt != 0 && now < activatedAt +
// 86400); this contract only ever records the timestamp.

const MIN_ITEM_RESERVE = 10000000; // 0.01 TON kept so the item never rots out of existence

// --- TEP-62 standard ops — opcodes are the standard values, not ours to choose ---

struct (0x5fcc3d14) Transfer {
    queryId: uint64
    newOwner: address
    responseDestination: address?
    customPayload: cell?
    forwardAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

struct (0x05138d91) OwnershipAssigned {
    queryId: uint64
    prevOwner: address
    forwardPayload: RemainingBitsAndRefs
}

struct (0xd53276db) Excesses {
    queryId: uint64
}

struct (0x2fcb26a2) GetStaticData {
    queryId: uint64
}

struct (0x8b771735) ReportStaticData {
    queryId: uint64
    index: uint256
    collection: address
}

// --- Our extension ---

struct (0x8000530f) Activate {
    queryId: uint64
}

type ItemMessage = Init | Transfer | GetStaticData | Activate

struct ItemStorage {
    index: uint64
    collection: address
    initialized: bool
    owner: address       // meaningless until initialized
    tier: uint8           // meaningless until initialized
    activatedAt: uint32
    content: cell          // meaningless until initialized
}

fun ItemStorage.toCell(self): cell {
    return beginCell()
        .storeUint(self.index, 64)
        .storeAddress(self.collection)
        .storeBool(self.initialized)
        .storeAddress(self.owner)
        .storeUint(self.tier, 8)
        .storeUint(self.activatedAt, 32)
        .storeRef(self.content)
        .endCell();
}

fun ItemStorage.fromCell(cell: cell): ItemStorage {
    var s = cell.beginParse();
    return ItemStorage {
        index: s.loadUint(64),
        collection: s.loadAddress(),
        initialized: s.loadBool(),
        owner: s.loadAddress(),
        tier: s.loadUint(8),
        activatedAt: s.loadUint(32),
        content: s.loadRef(),
    };
}

fun ItemStorage.load() {
    return ItemStorage.fromCell(contract.getData())
}

fun ItemStorage.save(self) {
    contract.setData(self.toCell());
}

// Must byte-for-byte match SkipCollection.tolk's itemInitialData() — the deploy address is a
// hash of this exact "blank" state (owner/tier/content are placeholders here; the collection
// reuses its own address as the placeholder owner since it's never read before initialized=true).
fun blankItemData(index: uint64, collection: address): cell {
    return ItemStorage {
        index: index,
        collection: collection,
        initialized: false,
        owner: collection,
        tier: 0,
        activatedAt: 0,
        content: beginCell().endCell(),
    }.toCell();
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy ItemMessage.fromSlice(in.body);
    match (msg) {
        Init => {
            var st = ItemStorage.load();
            assert (in.senderAddress == st.collection) throw ERR_NOT_ROOT;
            assert (!st.initialized) throw ERR_REPLAY;
            st.initialized = true;
            st.owner = msg.owner;
            st.tier = msg.tier;
            st.content = msg.content;
            st.save();
        }

        Transfer => {
            var st = ItemStorage.load();
            assert (in.senderAddress == st.owner) throw ERR_NOT_OWNER;

            val prevOwner = st.owner;
            st.owner = msg.newOwner;
            st.save();

            reserveGramsOnBalance(MIN_ITEM_RESERVE, RESERVE_MODE_AT_MOST);

            if (msg.forwardAmount > 0) {
                val notify = createMessage({
                    bounce: false,
                    value: msg.forwardAmount,
                    dest: msg.newOwner,
                    body: OwnershipAssigned { queryId: msg.queryId, prevOwner: prevOwner, forwardPayload: msg.forwardPayload },
                });
                notify.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }

            if (msg.responseDestination != null) {
                val excess = createMessage({
                    bounce: false,
                    value: 0,
                    dest: msg.responseDestination!,
                    body: Excesses { queryId: msg.queryId },
                });
                excess.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            }
        }

        GetStaticData => {
            val st = ItemStorage.load();
            val reply = createMessage({
                bounce: false,
                value: 0,
                dest: in.senderAddress,
                body: ReportStaticData { queryId: msg.queryId, index: st.index as uint256, collection: st.collection },
            });
            reply.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        Activate => {
            var st = ItemStorage.load();
            assert (in.senderAddress == st.owner) throw ERR_NOT_OWNER;
            assert (st.tier == TIER_24H_SKIP) throw ERR_WRONG_OP; // Forever has no activation concept
            st.activatedAt = blockchain.now();
            st.save();
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

get fun get_nft_data(): (int, int, address, address, cell) {
    val st = ItemStorage.load();
    return (st.initialized as int, st.index as int, st.collection, st.owner, st.content);
}

// Non-standard — activation state isn't part of TEP-62, exposed separately so standard
// tooling reading get_nft_data() stays unaffected.
get fun activationState(): (int, int) {
    val st = ItemStorage.load();
    return (st.tier, st.activatedAt);
}
