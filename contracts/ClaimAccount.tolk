tolk 1.4.2

import "constants.tolk"

// One ClaimAccount per claimant, sharded like Registry's SlotAccount — see
// docs/architecture.md "Per-claimant nonces live in a ClaimAccount child
// contract." Verifies the oracle's signed attestation and the per-wallet
// elapsed-time claim bound; the actual jetton payout and the shared bucket
// check happen at the root (RewardVault), since those need root's single
// serialized message queue to be race-free — see ClaimApproved's comment in
// constants.tolk.

struct ClaimAccountStorage {
    root: address
    owner: address
    lastNonce: uint64
    lastClaimTime: uint32
    lifetimeClaimed: coins
}

fun ClaimAccountStorage.toCell(self): cell {
    return beginCell()
        .storeAddress(self.root)
        .storeAddress(self.owner)
        .storeUint(self.lastNonce, 64)
        .storeUint(self.lastClaimTime, 32)
        .storeCoins(self.lifetimeClaimed)
        .endCell();
}

fun ClaimAccountStorage.fromCell(cell: cell): ClaimAccountStorage {
    var s = cell.beginParse();
    return ClaimAccountStorage {
        root: s.loadAddress(),
        owner: s.loadAddress(),
        lastNonce: s.loadUint(64),
        lastClaimTime: s.loadUint(32),
        lifetimeClaimed: s.loadCoins(),
    };
}

fun ClaimAccountStorage.load() {
    return ClaimAccountStorage.fromCell(contract.getData())
}

fun ClaimAccountStorage.save(self) {
    contract.setData(self.toCell());
}

type ClaimAccountMessage = ClaimFwd

fun onInternalMessage(in: InMessage) {
    val msg = lazy ClaimAccountMessage.fromSlice(in.body);
    match (msg) {
        ClaimFwd => {
            var st = ClaimAccountStorage.load();
            assert (in.senderAddress == st.root) throw ERR_NOT_ROOT;

            val attCell = msg.attestation;
            val att = attCell.load();
            val signature = msg.signature.load().bits;
            assert (att.magic == CLAIM_ATTESTATION_MAGIC) throw ERR_BAD_SIGNATURE;
            assert (att.vault == st.root) throw ERR_BAD_SIGNATURE;
            assert (att.claimant == st.owner) throw ERR_NOT_OWNER;
            assert (blockchain.now() < att.validUntil) throw ERR_EXPIRED;
            assert (att.nonce > st.lastNonce) throw ERR_REPLAY;
            assert (isSignatureValid(attCell.hash(), signature as slice, msg.signerKey)) throw ERR_BAD_SIGNATURE;

            // Hard safety ceiling: what real elapsed time could ever have produced under max
            // theoretical network-wide participation, regardless of what the oracle signed —
            // see docs/architecture.md "Per-wallet claim bound — provable, not rate-limited."
            // First-ever claim (lastNonce == 0, deploy left lastClaimTime at 0 to keep the deploy
            // address time-independent) gets a flat backlog grace window instead of ~now-now=0.
            val effectiveLastClaimTime = st.lastNonce == 0 ? max(blockchain.now() - INITIAL_CLAIM_WINDOW, 0) as uint32 : st.lastClaimTime;
            val hoursSinceLastClaim = (blockchain.now() - effectiveLastClaimTime) / 3600;
            assert (att.amount <= hoursSinceLastClaim * msg.cappedCeiling) throw ERR_CAP_EXCEEDED;
            assert (att.amount <= msg.maxPerClaim) throw ERR_CAP_EXCEEDED;

            st.lastNonce = att.nonce;
            st.lastClaimTime = blockchain.now();
            st.lifetimeClaimed += att.amount;
            st.save();

            val approved = createMessage({
                bounce: BounceMode.RichBounce, // ClaimApproved's body (opcode+queryId+address+coins) exceeds
                                                 // Only256BitsOfBody's budget; onBouncedMessage needs the full body.
                value: 0,
                dest: st.root,
                body: ClaimApproved { queryId: msg.queryId, claimant: st.owner, amount: att.amount },
            });
            approved.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

// Only one thing can bounce back here: a ClaimApproved we sent to root that root then rejected
// (bucket exhausted or the 9B lifetime cap reached). The claim never paid, so undo the stats
// field. lastNonce/lastClaimTime are deliberately NOT rewound — see docs/tokenomics.md; the
// oracle just re-attests the still-owed amount under a fresh nonce rather than this contract
// trying to reconstruct exact prior state, which is simpler and has no security downside (only
// a minor, self-correcting conservative delay on the next legitimate claim).
fun onBouncedMessage(in: InMessageBounced) {
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var body = rich.originalBody.beginParse();
    val originalOp = body.loadUint(32);
    if (originalOp == OP_CLAIM_APPROVED) {
        body.loadUint(64); // queryId
        body.loadAddress(); // claimant
        val amount = body.loadCoins();
        var st = ClaimAccountStorage.load();
        st.lifetimeClaimed -= amount;
        st.save();
    }
}

get fun lastNonceOf(): int {
    return ClaimAccountStorage.load().lastNonce;
}

get fun lastClaimTimeOf(): int {
    return ClaimAccountStorage.load().lastClaimTime;
}

get fun lifetimeClaimed(): int {
    return ClaimAccountStorage.load().lifetimeClaimed;
}

get fun ownerAddress(): address {
    return ClaimAccountStorage.load().owner;
}

get fun rootAddress(): address {
    return ClaimAccountStorage.load().root;
}
