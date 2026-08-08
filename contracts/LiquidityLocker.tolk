import "@stdlib/gas-payments";

const STATE_INITIAL        = 0;
const STATE_WAITING_SWAP_1  = 1;
const STATE_WAITING_SWAP_2  = 2;
const STATE_COMPLETE       = 3;

const OP_ROUTER_A_SWAP          = 0x25938561;
const OP_VAULT_B_SWAP           = 0xea06080d;
const OP_TRANSFER_NOTIFICATION  = 0x7362d09c;
const OP_ROUTER_A_LIQUIDITY     = 0x37c0db49;
const OP_VAULT_B_LIQUIDITY      = 0x12345678;

const MIN_STORAGE_RESERVE = 100000000;
const GAS_PER_MESSAGE     = 50000000;

const NO_ADDR: address? = null;

struct Storage {
    fsm_state: uint8;
    target_token: address;
    router_a: address;
    vault_b: address;
    swap_1_query_id: uint64;
    swap_2_query_id: uint64;
    reserved: uint64;
}

fun Storage.toCell(self): cell {
    return beginCell()
        .storeUint(self.fsm_state, 8)
        .storeAddress(self.target_token)
        .storeAddress(self.router_a)
        .storeAddress(self.vault_b)
        .storeUint(self.swap_1_query_id, 64)
        .storeUint(self.swap_2_query_id, 64)
        .storeUint(self.reserved, 64)
        .endCell();
}

fun Storage.fromCell(cell: cell): Storage {
    var s = cell.beginParse();
    return Storage {
        fsm_state: s.loadUint(8),
        target_token: s.loadAddress(),
        router_a: s.loadAddress(),
        vault_b: s.loadAddress(),
        swap_1_query_id: s.loadUint(64),
        swap_2_query_id: s.loadUint(64),
        reserved: s.loadUint(64),
    };
}

fun Storage.load(): Storage {
    var c = contract.getData();
    return Storage.fromCell(c);
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

fun getSenderFromMessage(msg: cell): address {
    var s = msg.beginParse();
    s.skipBits(4);
    return s.loadAddress();
}

fun computeTokenWallet(token: address): address {
    return token;
}

fun onInternalMessage(myBalance: int, msgValue: int, inMsgFull: cell, inMsgBody: slice) {
    var storage = Storage.load();

    if (msgValue > 0 && storage.fsm_state == STATE_INITIAL) {
        reserveGramsOnBalance(MIN_STORAGE_RESERVE + 4 * GAS_PER_MESSAGE + 50000000, 0);

        val reservedAmount = MIN_STORAGE_RESERVE + 4 * GAS_PER_MESSAGE + 50000000;
        val originalBalance = contract.getOriginalBalance();
        val usable = originalBalance - reservedAmount;

        if (usable < 400000000) {
            return;
        }

        storage.reserved = reservedAmount;
        val portion = usable / 4;

        val queryId1 = blockchain.now() as uint64;
        val queryId2 = (blockchain.now() + 1) as uint64;

        val receiver = contract.getAddress();
        val bodyA = beginCell()
            .storeUint(OP_ROUTER_A_SWAP, 32)
            .storeUint(queryId1, 64)
            .storeAddress(NO_ADDR!)
            .storeCoins(0)
            .storeAddress(receiver)
            .storeAddress(NO_ADDR!)
            .endCell();

        val reqA = createMessage({
            bounce: false,
            value: portion,
            dest: storage.router_a,
            body: bodyA,
        });
        reqA.send(0);

        val poolAddr = storage.target_token;
        val bodyB = beginCell()
            .storeUint(OP_VAULT_B_SWAP, 32)
            .storeUint(queryId2, 64)
            .storeAddress(poolAddr)
            .endCell();

        val reqB = createMessage({
            bounce: false,
            value: portion,
            dest: storage.vault_b,
            body: bodyB,
        });
        reqB.send(0);

        storage.swap_1_query_id = queryId1;
        storage.swap_2_query_id = queryId2;
        storage.fsm_state = STATE_WAITING_SWAP_1;
        storage.save();
        return;
    }

    var bodySlice = inMsgBody;
    if (bodySlice.remainingBitsCount() >= 32) {
        var op = bodySlice.loadUint(32);

        if (op == OP_TRANSFER_NOTIFICATION) {
            var sender = getSenderFromMessage(inMsgFull);
            var expectedWallet = computeTokenWallet(storage.target_token);
            if (sender != expectedWallet) {
                return;
            }

            if (bodySlice.remainingBitsCount() < 64) {
                return;
            }
            var qid = bodySlice.loadUint(64);

            if (storage.fsm_state == STATE_WAITING_SWAP_1) {
                if (qid == storage.swap_1_query_id) {
                    storage.fsm_state = STATE_WAITING_SWAP_2;
                    storage.save();
                }
            } else if (storage.fsm_state == STATE_WAITING_SWAP_2) {
                if (qid == storage.swap_2_query_id) {
                    storage.fsm_state = STATE_COMPLETE;
                    storage.save();

                    val originalBalance = contract.getOriginalBalance();
                    val usable = originalBalance - storage.reserved;

                    val half1 = usable / 2;
                    val half2 = usable - half1;

                    val receiver = contract.getAddress();
                    val jettonAmount = 0;
                    val deadline = (blockchain.now() + 3600) as uint64;

                    val liqBodyA = beginCell()
                        .storeUint(OP_ROUTER_A_LIQUIDITY, 32)
                        .storeUint(0, 64)
                        .storeAddress(NO_ADDR!)
                        .storeAddress(storage.target_token)
                        .storeCoins(half1)
                        .storeCoins(jettonAmount)
                        .storeCoins(0)
                        .storeAddress(receiver)
                        .storeUint(deadline, 64)
                        .endCell();

                    val liqReqA = createMessage({
                        bounce: false,
                        value: half1,
                        dest: storage.router_a,
                        body: liqBodyA,
                    });
                    liqReqA.send(0);

                    val liqBodyB = beginCell()
                        .storeUint(OP_VAULT_B_LIQUIDITY, 32)
                        .storeUint(0, 64)
                        .storeAddress(NO_ADDR!)
                        .storeAddress(storage.target_token)
                        .storeCoins(half2)
                        .storeCoins(jettonAmount)
                        .storeCoins(0)
                        .storeAddress(receiver)
                        .storeUint(deadline, 64)
                        .endCell();

                    val liqReqB = createMessage({
                        bounce: false,
                        value: half2,
                        dest: storage.vault_b,
                        body: liqBodyB,
                    });
                    liqReqB.send(0);
                }
            }
        }
    }
}

get fun getState(): int {
    return Storage.load().fsm_state as int;
}

get fun getTargetToken(): address {
    return Storage.load().target_token;
}

get fun getRouterA(): address {
    return Storage.load().router_a;
}

get fun getVaultB(): address {
    return Storage.load().vault_b;
}

get fun getTokenWallet(): address {
    return computeTokenWallet(Storage.load().target_token);
}

get fun isComplete(): int {
    return (Storage.load().fsm_state == STATE_COMPLETE) as int;
}
