// =====================================================================================
// REFERENCE ONLY — not part of the build, not compiled, not deployed.
//
// An earlier exploratory design for a self-contained mock DEX kit (mock jetton wallets,
// pool swap/liquidity/refund ops) — kept here in case it's useful for sandbox-testing the
// real Router against fake pools before STON.fi/DeDust integration is ready. See
// docs/architecture.md's Router section and docs/tokenomics.md for the actual, current
// design; do not treat anything in this file as reflecting current contract behavior.
// =====================================================================================

// =====================================================================================
// common.tolk
// Shared op-codes and message layouts for the GRAM zap-into-two-pools testnet mock kit.
//
// DESIGN NOTE ON ADDRESSES (read this before wiring things up):
// Real jetton/DEX contracts usually *derive* a counterparty's jetton-wallet address
// on-chain from (owner, jetton-master, wallet-code). To keep this mock kit compact and
// easy to reason about/audit, every contract instead stores its counterparty wallet
// addresses explicitly in its own storage, set once by the admin via SetConfig after
// deployment (you compute the addresses off-chain with your deploy script / ton.org
// address book, the same way you'd read them off an explorer). This is a legitimate,
// commonly used pattern -- it just trades a bit of on-chain elegance for much simpler,
// more auditable code. If you later want on-chain derivation (so the system is fully
// permissionless / doesn't trust the admin's SetConfig call), swap in
// AutoDeployAddress.calculateAddress() using each wallet's known code+data layout.
// =====================================================================================

// ---- Standard TEP-74 jetton op-codes ----
const OP_JETTON_TRANSFER              = 0x0f8a7ea5;
const OP_JETTON_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_JETTON_INTERNAL_TRANSFER     = 0x178d4519;
const OP_JETTON_EXCESSES              = 0xd53276db;
const OP_JETTON_BURN                  = 0x595f07bc;
const OP_JETTON_BURN_NOTIFICATION     = 0x7bdd97de;

// ---- Mock-minter-only op (not part of TEP-74; admin faucet mint for testnet) ----
const OP_MOCK_MINT = 0x4d494e54; // "MINT"

// ---- Pool ops, carried as the `forwardPayload` ref cell on a jetton transfer ----
const OP_POOL_SWAP              = 0x504f4f31; // "POO1" swap request
const OP_POOL_SWAP_RESULT       = 0x504f4f32; // "POO2" swap output notification
const OP_POOL_PROVIDE_LIQUIDITY = 0x504f4f33; // "POO3" one leg of a two-sided LP deposit
const OP_POOL_LP_CONFIRMED      = 0x504f4f34; // "POO4" LP credited, sent back to depositor
const OP_POOL_REFUND            = 0x504f4f35; // "POO5" swap/LP leg refunded (e.g. bad sender)

// ---- Zap op ----
const OP_ZAP_STATUS = 0x5a415031; // "ZAP1" informational status ping (get-method mirror, optional)

// Minimum TON forwarded so a receiving contract can afford to process + re-forward.
const FORWARD_TON_FOR_SWAP    = ton("0.12");
const FORWARD_TON_FOR_LIQUIDITY = ton("0.12");
const GAS_FOR_JETTON_TRANSFER = ton("0.05");

// =====================================================================================
// TEP-74 message layouts.
// forwardPayload is always stored as a REFERENCE cell in this kit (Either-bit = 1) for
// simplicity. Production TEP-74 wallets must also accept the inline form; these mock
// wallets only talk to each other, so this simplification is safe here.
// =====================================================================================

@overflow1023_policy("suppress")
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseDestination: any_address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: cell
}

struct (0x7362d09c) JettonTransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    forwardPayload: cell
}

@overflow1023_policy("suppress")
struct (0x178d4519) JettonInternalTransfer {
    queryId: uint64
    amount: coins
    from: address
    responseAddress: any_address
    forwardTonAmount: coins
    forwardPayload: cell
}

struct (0xd53276db) JettonExcesses {
    queryId: uint64
}

struct (0x595f07bc) JettonBurn {
    queryId: uint64
    amount: coins
    responseDestination: any_address
    customPayload: cell?
}

struct (0x7bdd97de) JettonBurnNotification {
    queryId: uint64
    amount: coins
    sender: address
    responseDestination: any_address
}

struct (0x4d494e54) MockMint {
    queryId: uint64
    toAddress: address
    amount: coins
}

// =====================================================================================
// Pool payloads. These live *inside* the `forwardPayload` ref cell of a JettonTransfer /
// JettonTransferNotification above -- they are how the zap contract tells a pool what
// to do with the jettons that are riding along in the same message.
// =====================================================================================

struct (0x504f4f31) PoolSwapRequest {
    queryId: uint64
    minAmountOut: coins   // 0 = no slippage protection (per your instruction)
    recipient: address    // who should receive the swapped-out jetton
}

struct (0x504f4f32) PoolSwapResult {
    queryId: uint64
}

struct (0x504f4f33) PoolProvideLiquidity {
    queryId: uint64
    minLpOut: coins        // 0 = no slippage protection
    recipient: address     // who gets credited with LP units
}

struct (0x504f4f34) PoolLpConfirmed {
    queryId: uint64
    lpAmount: coins
}

struct (0x504f4f35) PoolRefund {
    queryId: uint64
    reason: uint32
}

// Sent directly (not jetton-wrapped) by a depositor who wants to pull liquidity back out.
struct (0x504f4f36) PoolRemoveLiquidity {
    queryId: uint64
    lpAmount: coins
}

type PoolAction = PoolSwapRequest | PoolProvideLiquidity

// Empty marker payload used as forwardPayload when nothing extra needs saying.
struct (0x0) EmptyPayload {
}

// =====================================================================================
// Shared jetton-wallet address helper.
// Every mock jetton in this kit (GRAM, TokenX, LP-A, LP-B) reuses the SAME wallet
// contract code (jetton-wallet.tolk). A wallet's address is the hash of its initial
// state (code + deploy-time data), and that address never changes even as its balance
// changes later -- so this same computation is valid at any point in time, not just
// at deploy.
// =====================================================================================

struct WalletStorage {
    balance: coins
    ownerAddress: address
    jettonMasterAddress: address
    jettonWalletCode: cell
}

fun buildEmptyWalletStorage(owner: address, master: address, code: cell): cell {
    val st: WalletStorage = { balance: 0, ownerAddress: owner, jettonMasterAddress: master, jettonWalletCode: code };
    return st.toCell();
}

fun calcJettonWalletAddress(owner: address, master: address, code: cell): address {
    val dest: AutoDeployAddress = { workchain: 0, stateInit: { code: code, data: buildEmptyWalletStorage(owner, master, code) } };
    return dest.calculateAddress();
}

// Integer square root (Newton's method), used for initial LP-share minting.
fun isqrt(x: int): int {
    if (x <= 0) {
        return 0;
    }
    var z = x;
    var y = (x + 1) / 2;
    while (y < z) {
        z = y;
        y = (x / y + y) / 2;
    }
    return z;
}
