tolk 1.4.2

import "constants.tolk"

// Custodies the 9B reward allocation, tracks the halving schedule via
// cumulativeMined, and pays out signed claim attestations through sharded
// ClaimAccount children — see docs/architecture.md "Reward Vault."

const TOTAL_ALLOCATION = 9000000000000000000; // 9,000,000,000 tokens * 10^9 decimals — hard, never exceeded

const TIMELOCK_DELAY = 172800; // 48h — raising bucketCapacity/maxPerClaim is timelocked; pause/key rotation is not (see architecture.md's asymmetry rule)

const JETTON_TRANSFER_GAS = 50000000; // 0.05 TON forwarded to the Vault's jetton wallet to cover its own processing+forward

struct (0x80005201) Claim {
    queryId: uint64
    attestation: Cell<ClaimAttestation>
    signature: Cell<Signature>
}

struct (0x80005205) SetSignerKey {
    signerKey: uint256
}

// The Vault's jetton wallet address is a function of (jetton master, Vault's own address), which
// isn't known until AFTER the Vault deploys — deploy with a placeholder, then call this once the
// real wallet address is computed. Same pattern as Registry's SetRouter.
struct (0x80005209) SetJettonWallet {
    jettonWallet: address
}

struct (0x80005206) SetPaused {
    paused: bool
}

struct (0x80005207) ProposeLimits {
    bucketCapacity: coins
    maxPerClaim: coins
}

struct (0x80005208) ApplyLimits {
    queryId: uint64
}

type RootMessage = Claim | ClaimApproved | SetSignerKey | SetJettonWallet | SetPaused | ProposeLimits | ApplyLimits

struct VaultStorage {
    admin: address
    signerKey: uint256
    jettonWallet: address
    claimAccountCode: cell
    cumulativeMined: coins
    halvingInterval: coins
    baseRate: coins        // tokens/hour, raw units, at epoch 0 (uncapped, "typical pace")
    maxPerClaim: coins
    bucketCapacity: coins
    bucketAvailable: coins
    lastRefillAt: uint32
    paused: bool
    pendingBucketCapacity: coins
    pendingMaxPerClaim: coins
    pendingEffectiveAt: uint32 // 0 = no pending change
}

// admin+signerKey+jettonWallet+paused alone fit in one cell; the rest (mostly
// max-width coins fields) are split into a ref to stay under the 1023-bit limit.
fun VaultStorage.toCell(self): cell {
    val extra = beginCell()
        .storeCoins(self.cumulativeMined)
        .storeCoins(self.halvingInterval)
        .storeCoins(self.baseRate)
        .storeCoins(self.maxPerClaim)
        .storeCoins(self.bucketCapacity)
        .storeCoins(self.bucketAvailable)
        .storeUint(self.lastRefillAt, 32)
        .storeCoins(self.pendingBucketCapacity)
        .storeCoins(self.pendingMaxPerClaim)
        .storeUint(self.pendingEffectiveAt, 32)
        .endCell();
    return beginCell()
        .storeAddress(self.admin)
        .storeUint(self.signerKey, 256)
        .storeAddress(self.jettonWallet)
        .storeBool(self.paused)
        .storeRef(self.claimAccountCode)
        .storeRef(extra)
        .endCell();
}

fun VaultStorage.fromCell(cell: cell): VaultStorage {
    var s = cell.beginParse();
    val admin = s.loadAddress();
    val signerKey = s.loadUint(256);
    val jettonWallet = s.loadAddress();
    val paused = s.loadBool();
    val claimAccountCode = s.loadRef();
    var e = s.loadRef().beginParse();
    return VaultStorage {
        admin: admin,
        signerKey: signerKey,
        jettonWallet: jettonWallet,
        claimAccountCode: claimAccountCode,
        cumulativeMined: e.loadCoins(),
        halvingInterval: e.loadCoins(),
        baseRate: e.loadCoins(),
        maxPerClaim: e.loadCoins(),
        bucketCapacity: e.loadCoins(),
        bucketAvailable: e.loadCoins(),
        lastRefillAt: e.loadUint(32),
        paused: paused,
        pendingBucketCapacity: e.loadCoins(),
        pendingMaxPerClaim: e.loadCoins(),
        pendingEffectiveAt: e.loadUint(32),
    };
}

fun VaultStorage.load() {
    return VaultStorage.fromCell(contract.getData())
}

fun VaultStorage.save(self) {
    contract.setData(self.toCell());
}

// Pure function of cumulativeMined — no oracle input, no stored per-epoch table.
// epoch N+ once baseRate>>epoch underflows to 0 just means emission has tapered
// to nothing; TOTAL_ALLOCATION is the actual hard stop, checked separately.
fun epochRate(st: VaultStorage): coins {
    val epoch = st.cumulativeMined / st.halvingInterval;
    return st.baseRate >> epoch;
}

// Deploy address is a hash of this data, so it must depend ONLY on (vault, owner) — nothing
// time-varying. The 14-day first-claim grace window is applied at claim-processing time
// instead (see ClaimAccount.tolk), keyed off lastNonce == 0, not baked in here.
fun claimAccountInitialData(vault: address, owner: address): cell {
    return beginCell()
        .storeAddress(vault)
        .storeAddress(owner)
        .storeUint(0, 64) // lastNonce
        .storeUint(0, 32) // lastClaimTime
        .storeCoins(0) // lifetimeClaimed
        .endCell();
}

fun claimAccountDeployDest(st: VaultStorage, owner: address): AutoDeployAddress {
    return {
        stateInit: {
            code: st.claimAccountCode,
            data: claimAccountInitialData(contract.getAddress(), owner),
        },
    };
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy RootMessage.fromSlice(in.body);
    match (msg) {
        Claim => {
            val st = VaultStorage.load();
            assert (!st.paused) throw ERR_PAUSED;

            val cappedCeiling = epochRate(st) * 2;

            val fwd = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: claimAccountDeployDest(st, in.senderAddress),
                value: 0,
                body: ClaimFwd {
                    queryId: msg.queryId,
                    attestation: msg.attestation,
                    signature: msg.signature,
                    signerKey: st.signerKey,
                    cappedCeiling: cappedCeiling,
                    maxPerClaim: st.maxPerClaim,
                },
            });
            fwd.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        ClaimApproved => {
            var st = VaultStorage.load();
            val expectedChild = claimAccountDeployDest(st, msg.claimant).calculateAddress();
            assert (in.senderAddress == expectedChild) throw ERR_NOT_ROOT;

            assert (st.cumulativeMined + msg.amount <= TOTAL_ALLOCATION) throw ERR_CAP_EXCEEDED;

            val nowTs = blockchain.now();
            val rate = epochRate(st);
            val refillPerSecond = rate / 3600;
            val elapsed = nowTs - st.lastRefillAt;
            val refilled = min(st.bucketCapacity, st.bucketAvailable + refillPerSecond * elapsed);
            assert (msg.amount <= refilled) throw ERR_BUSY;

            st.bucketAvailable = refilled - msg.amount;
            st.lastRefillAt = nowTs;
            st.cumulativeMined += msg.amount;
            st.save();

            val emptyPayload = beginCell().endCell().beginParse();
            val transfer = createMessage({
                bounce: BounceMode.RichBounce, // JettonTransfer's body exceeds Only256BitsOfBody's
                                                 // budget; onBouncedMessage needs the full amount to reverse.
                value: JETTON_TRANSFER_GAS,
                dest: st.jettonWallet,
                body: JettonTransfer {
                    queryId: msg.queryId,
                    amount: msg.amount,
                    destination: msg.claimant,
                    responseDestination: contract.getAddress(),
                    customPayload: null,
                    forwardTonAmount: 0,
                    forwardPayload: emptyPayload,
                },
            });
            transfer.send(SEND_MODE_PAY_FEES_SEPARATELY);

            val log = createExternalLogMessage({
                dest: ExtOutLogBucket { topic: TOPIC_CLAIM_PAID },
                body: msg,
            });
            log.send(SEND_MODE_REGULAR);
        }

        SetSignerKey => {
            var st = VaultStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.signerKey = msg.signerKey;
            st.save();
        }

        SetJettonWallet => {
            var st = VaultStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.jettonWallet = msg.jettonWallet;
            st.save();
        }

        SetPaused => {
            var st = VaultStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.paused = msg.paused;
            st.save();
        }

        ProposeLimits => {
            var st = VaultStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.pendingBucketCapacity = msg.bucketCapacity;
            st.pendingMaxPerClaim = msg.maxPerClaim;
            st.pendingEffectiveAt = (blockchain.now() + TIMELOCK_DELAY) as uint32;
            st.save();
        }

        ApplyLimits => {
            var st = VaultStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            assert (st.pendingEffectiveAt != 0) throw ERR_BUSY;
            assert (blockchain.now() >= st.pendingEffectiveAt) throw ERR_BUSY;
            st.bucketCapacity = st.pendingBucketCapacity;
            st.maxPerClaim = st.pendingMaxPerClaim;
            st.pendingEffectiveAt = 0;
            st.save();
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

// Only a bounced JettonTransfer reaches root (a bounced ClaimApproved reaches the CHILD that
// sent it, not root — see ClaimAccount.tolk's onBouncedMessage). The payout never happened, so
// undo root's own accounting; the claimant's ClaimAccount is untouched (see docs/tokenomics.md
// for why nonce/lastClaimTime are deliberately not rewound anywhere in this design).
fun onBouncedMessage(in: InMessageBounced) {
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var body = rich.originalBody.beginParse();
    val originalOp = body.loadUint(32);
    if (originalOp == OP_JETTON_TRANSFER) {
        body.loadUint(64); // queryId
        val amount = body.loadCoins();
        var st = VaultStorage.load();
        st.cumulativeMined -= amount;
        st.bucketAvailable += amount;
        st.save();
    }
}

get fun cumulativeMined(): int {
    return VaultStorage.load().cumulativeMined;
}

get fun currentEpochRate(): int {
    return epochRate(VaultStorage.load());
}

get fun bucketState(): (int, int, int) {
    val st = VaultStorage.load();
    return (st.bucketCapacity, st.bucketAvailable, st.lastRefillAt);
}

get fun signerKey(): int {
    return VaultStorage.load().signerKey;
}

get fun adminAddress(): address {
    return VaultStorage.load().admin;
}

get fun jettonWalletAddress(): address {
    return VaultStorage.load().jettonWallet;
}

get fun isPaused(): int {
    return VaultStorage.load().paused as int;
}

get fun pendingLimits(): (int, int, int) {
    val st = VaultStorage.load();
    return (st.pendingBucketCapacity, st.pendingMaxPerClaim, st.pendingEffectiveAt);
}

get fun maxPerClaim(): int {
    return VaultStorage.load().maxPerClaim;
}

get fun claimAccountAddressOf(owner: address): address {
    val st = VaultStorage.load();
    return claimAccountDeployDest(st, owner).calculateAddress();
}
