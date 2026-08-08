tolk 1.4.2

import "constants.tolk"

// One ReferralAccount per wallet that has ever attempted a referral-claim mint — sharded
// like Registry's SlotAccount / Vault's ClaimAccount, for the same reason: a per-wallet
// nonce dictionary on the root would serialize every referral claim through one message
// queue. This contract ONLY tracks replay (lastReferralNonce); the free-mint rate-limit
// bucket is root-level global state — see docs/tokenomics.md "Rate-limit bucket" and
// SkipCollection.tolk's ReferralApproved handler.

struct ReferralAccountStorage {
    collection: address
    owner: address
    lastReferralNonce: uint64
}

fun ReferralAccountStorage.toCell(self): cell {
    return beginCell()
        .storeAddress(self.collection)
        .storeAddress(self.owner)
        .storeUint(self.lastReferralNonce, 64)
        .endCell();
}

fun ReferralAccountStorage.fromCell(cell: cell): ReferralAccountStorage {
    var s = cell.beginParse();
    return ReferralAccountStorage {
        collection: s.loadAddress(),
        owner: s.loadAddress(),
        lastReferralNonce: s.loadUint(64),
    };
}

fun ReferralAccountStorage.load() {
    return ReferralAccountStorage.fromCell(contract.getData())
}

fun ReferralAccountStorage.save(self) {
    contract.setData(self.toCell());
}

type ReferralAccountMessage = ReferralClaimFwd

fun onInternalMessage(in: InMessage) {
    val msg = lazy ReferralAccountMessage.fromSlice(in.body);
    match (msg) {
        ReferralClaimFwd => {
            var st = ReferralAccountStorage.load();
            assert (in.senderAddress == st.collection) throw ERR_NOT_ROOT;

            val attCell = msg.attestation;
            val att = attCell.load();
            val signature = msg.signature.load().bits;
            assert (att.magic == REFERRAL_ATTESTATION_MAGIC) throw ERR_BAD_SIGNATURE;
            assert (att.collection == st.collection) throw ERR_BAD_SIGNATURE;
            assert (att.claimant == st.owner) throw ERR_NOT_OWNER;
            assert (blockchain.now() < att.validUntil) throw ERR_EXPIRED;
            assert (att.nonce > st.lastReferralNonce) throw ERR_REPLAY;
            assert (isSignatureValid(attCell.hash(), signature as slice, msg.signerKey)) throw ERR_BAD_SIGNATURE;

            st.lastReferralNonce = att.nonce;
            st.save();

            // Nothing to roll back if root rejects (bucket exhausted): unlike ClaimAccount,
            // there's no coins/lifetime stat here — only the nonce, which stays advanced by
            // design (see docs/tokenomics.md; the oracle just re-attests under a fresh nonce).
            val approved = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: st.collection,
                body: ReferralApproved { queryId: msg.queryId, claimant: st.owner },
            });
            approved.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

get fun lastReferralNonceOf(): int {
    return ReferralAccountStorage.load().lastReferralNonce;
}

get fun ownerAddress(): address {
    return ReferralAccountStorage.load().owner;
}

get fun collectionAddress(): address {
    return ReferralAccountStorage.load().collection;
}
