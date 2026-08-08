tolk 1.4.2

// Shared across SlotRegistry, SkipCollection/SkipItem, Router, RewardVault.
// Keep every opcode and error code in this one file — a collision between
// two contracts' opcodes is silent at compile time and catastrophic at runtime.

const ERR_WRONG_OP        = 0xFFFF;
const ERR_NOT_OWNER       = 401;
const ERR_NOT_ROOT        = 402;
const ERR_INSUFFICIENT    = 403;
const ERR_CAP_EXCEEDED    = 404;
const ERR_BAD_SIGNATURE   = 405;
const ERR_EXPIRED         = 406;
const ERR_REPLAY          = 407;
const ERR_PAUSED          = 408;
const ERR_BUSY            = 409;

const TOPIC_SLOT_BOUGHT   = 1;
const TOPIC_TIER_MINTED   = 2;
const TOPIC_CYCLE_DONE    = 3;
const TOPIC_CLAIM_PAID    = 4;

// Slot price curve parameters (Registry). Immutable per deployment — see
// docs/architecture.md's "The price curve" section for why: a mutable curve
// means a quote fetched at time t can be invalidated before the tx lands.
struct CurveParams {
    basePrice: coins
    num: uint16
    den: uint16
    maxSlots: uint8
}

// Registry root -> SlotAccount child. Shared here (rather than defined in
// SlotAccount.tolk) because SlotRegistry.tolk needs to construct it too.
struct (0x80005102) BuySlotFwd {
    queryId: uint64
    buyer: address
    router: address
    curve: CurveParams
}

// --- RewardVault ---
//
// Domain-separated claim payload the off-chain oracle signs. `magic` +
// `vault` prevent a signature from being replayed across deployments,
// networks, or forks — see docs/architecture.md "Attestation format and
// replay." Not opcode-prefixed: it's a data payload nested inside Claim /
// ClaimFwd, never dispatched on its own.
const CLAIM_ATTESTATION_MAGIC = 0x52565431; // "RVT1"

// Tolk requires opcode literals directly in `struct (0x...)` declarations, so
// these can't be the single source of truth — but onBouncedMessage handlers
// compare against these names instead of a bare magic number at the call site.
// Keep in sync with the struct declarations below if either ever changes.
const OP_CLAIM_FWD      = 0x80005202;
const OP_CLAIM_APPROVED = 0x80005203;
const OP_JETTON_TRANSFER = 0x0f8a7ea5;

// New wallets get a flat backlog allowance instead of ~0 on their first-ever
// claim (which "hours since last claim" would otherwise give them, since
// there's no real prior claim to measure from). Matches the same "size for
// realistic backlog" reasoning as the Vault's bucket capacity. Used by
// RewardVault when constructing a new ClaimAccount's initial deploy data.
const INITIAL_CLAIM_WINDOW = 1209600; // 14 days, in seconds

struct ClaimAttestation {
    magic: uint32
    vault: address
    claimant: address
    amount: coins
    nonce: uint64
    validUntil: uint32
}

// Trivial wrapper so the Ed25519 signature can live in its own ref cell —
// Claim/ClaimFwd exceed the 1023-bit single-cell budget once attestation
// (~786 bits worst case) and a 512-bit signature are both inline.
struct Signature {
    bits: bits512
}

// RewardVault root -> ClaimAccount child. Carries everything the child needs
// to verify independently of the root's CURRENT mutable state at the time
// the child actually processes this (signerKey can rotate between when this
// is sent and when it lands — using the value captured here, not a stale
// local copy, keeps verification consistent with what root authorized).
struct (0x80005202) ClaimFwd {
    queryId: uint64
    attestation: Cell<ClaimAttestation>
    signature: Cell<Signature>
    signerKey: uint256
    cappedCeiling: coins   // network-wide hourly ceiling at the 2x multiplier cap, current epoch
    maxPerClaim: coins
}

// ClaimAccount child -> RewardVault root, once the child has verified
// signature/nonce/expiry/per-wallet time bound and updated its own state.
// The root still owns the bucket check and the actual jetton payout — see
// docs/architecture.md "Per-wallet claim bound" for why this can't collapse
// into a single hop (the bucket is shared global state; only root's own
// serialized message queue can check-and-deduct it race-free).
struct (0x80005203) ClaimApproved {
    queryId: uint64
    claimant: address
    amount: coins
}

// Standard TEP-74 jetton transfer, sent from the Vault's own jetton wallet.
// Opcode is the TEP-74 standard value, not ours to choose.
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseDestination: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}
