tolk 1.4.2

import "constants.tolk"

// Skip NFT collection — one collection, two tiers (TIER_24H_SKIP, TIER_FOREVER)
// differentiated by a stored field per item, not two collection contracts. See
// docs/tokenomics.md "Shape" for why: standard-enough TEP-62 for Getgems/wallets/indexers,
// both tiers transferable (neither soulbound), oracle reads holders directly off-chain.
//
// Two entry points converge on one shared mintItem() helper (deployItem below), same
// pattern as Registry/Vault's shared-helper-with-different-gates:
//   - PaidMint: sender pays SKIP_24H_PRICE or SKIP_FOREVER_PRICE, immediate, no rate limit —
//     payment itself is the gate. TON routes to Router exactly like SlotAccount: reserve +
//     gas buffer, forward remainder, refund excess, retry-on-bounce via pendingForward.
//   - ReferralClaim: free (gas only), gated by a signed oracle attestation AND the
//     collection's own free-mint rate-limit bucket (root-level global state — a per-wallet
//     limit does nothing against a key signing attestations for many distinct wallets).
//     Always mints TIER_24H_SKIP; the referral path never grants Forever.

const SKIP_24H_PRICE     = 5000000000;  // 5 TON
const SKIP_FOREVER_PRICE = 10000000000; // 10 TON

const MIN_COLLECTION_RESERVE = 10000000; // 0.01 TON rent-exempt reserve
const GAS_BUFFER = 30000000;             // 0.03 TON — covers router-forward + refund + log fees under PAY_FEES_SEPARATELY
const ITEM_DEPLOY_GAS = 50000000;        // 0.05 TON forwarded to fund each new SkipItem's deploy + rent

const TIMELOCK_DELAY = 172800; // 48h — same asymmetry as RewardVault: raising the bucket cap
                                 // is timelocked, pausing/tightening is immediate via admin.

struct (0x80005301) PaidMint {
    queryId: uint64
    tier: uint8
}

struct (0x80005302) ReferralClaim {
    queryId: uint64
    attestation: Cell<ReferralAttestation>
    signature: Cell<Signature>
}

struct (0x80005303) SetRouter {
    router: address
}

struct (0x80005304) SetSignerKey {
    signerKey: uint256
}

struct (0x80005305) SetPaused {
    paused: bool
}

struct (0x80005306) ProposeLimits {
    freeMintBucketCapacity: uint16
}

struct (0x80005307) ApplyLimits {
    queryId: uint64
}

struct (0x80005308) RetryForward {
    queryId: uint64
}

// Root -> Router. Tiny/tagged (rather than a bare empty-body transfer) purely so
// onBouncedMessage can unambiguously identify a bounced forward vs. a bounced ReferralClaimFwd.
struct (0x80005309) RouterForward {
    queryId: uint64
}

struct (0x8000530d) SetContent {
    collectionContent: cell
    content24h: cell
    contentForever: cell
}

struct (0x8000530e) TierMintedLog {
    owner: address
    tier: uint8
    index: uint64
}

type RootMessage = PaidMint | ReferralClaim | ReferralApproved | SetRouter | SetSignerKey | SetPaused | ProposeLimits | ApplyLimits | RetryForward | SetContent

// TEP-64 off-chain content cell: tag byte 0x01 + URI. Placeholder content for now — real
// art/JSON swaps in later via SetContent, no redeploy needed.
fun offchainContent(uri: string): cell {
    return beginCell().storeUint(1, 8).storeString(uri).endCell();
}

// --- Storage, split into sub-cells to stay under the 1023-bit/4-ref single-cell budget ---
// (see the same pattern in RewardVault.tolk / SlotRegistry.tolk).

struct CodeCell {
    itemCode: cell
    referralAccountCode: cell
}

struct ContentCell {
    collectionContent: cell
    content24h: cell
    contentForever: cell
}

struct EconomicsCell {
    nextItemIndex: uint64
    pendingForward: coins
    freeMintBucketCapacity: uint16
    freeMintBucketAvailable: uint16
    lastFreeMintRefillAt: uint32
    pendingFreeMintBucketCapacity: uint16
    pendingEffectiveAt: uint32
}

struct CollectionStorage {
    admin: address
    router: address
    signerKey: uint256
    paused: bool
    code: CodeCell
    content: ContentCell
    economics: EconomicsCell
}

fun CollectionStorage.toCell(self): cell {
    return beginCell()
        .storeAddress(self.admin)
        .storeAddress(self.router)
        .storeUint(self.signerKey, 256)
        .storeBool(self.paused)
        .storeRef(self.code.toCell())
        .storeRef(self.content.toCell())
        .storeRef(self.economics.toCell())
        .endCell();
}

fun CollectionStorage.fromCell(cell: cell): CollectionStorage {
    var s = cell.beginParse();
    val admin = s.loadAddress();
    val router = s.loadAddress();
    val signerKey = s.loadUint(256);
    val paused = s.loadBool();
    val code = CodeCell.fromCell(s.loadRef());
    val content = ContentCell.fromCell(s.loadRef());
    val economics = EconomicsCell.fromCell(s.loadRef());
    return CollectionStorage {
        admin: admin,
        router: router,
        signerKey: signerKey,
        paused: paused,
        code: code,
        content: content,
        economics: economics,
    };
}

fun CollectionStorage.load() {
    return CollectionStorage.fromCell(contract.getData())
}

fun CollectionStorage.save(self) {
    contract.setData(self.toCell());
}

// Must byte-for-byte match SkipItem.tolk's blankItemData() — the deploy address is a hash of
// this exact "blank" state, independent of owner/tier so get_nft_address_by_index(index) is
// computable with no other input, per TEP-62 convention. See SkipItem.tolk's header comment.
fun itemInitialData(collection: address, index: uint64): cell {
    return beginCell()
        .storeUint(index, 64)
        .storeAddress(collection)
        .storeBool(false) // initialized
        .storeAddress(collection) // owner placeholder — never read before initialized=true
        .storeUint(0, 8) // tier placeholder
        .storeUint(0, 32) // activatedAt
        .storeRef(beginCell().endCell()) // content placeholder
        .endCell();
}

fun itemDeployDest(st: CollectionStorage, index: uint64): AutoDeployAddress {
    return {
        stateInit: {
            code: st.code.itemCode,
            data: itemInitialData(contract.getAddress(), index),
        },
    };
}

fun referralAccountDeployDest(st: CollectionStorage, owner: address): AutoDeployAddress {
    return {
        stateInit: {
            code: st.code.referralAccountCode,
            data: beginCell().storeAddress(contract.getAddress()).storeAddress(owner).storeUint(0, 64).endCell(),
        },
    };
}

// Shared by both entry points — the only difference between paths is what gates entry here.
fun deployItem(st: CollectionStorage, owner: address, tier: int, value: coins): int {
    val index = st.economics.nextItemIndex;
    val dest = itemDeployDest(st, index);
    val content = tier == TIER_FOREVER ? st.content.contentForever : st.content.content24h;
    val deployMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: value,
        dest: dest,
        body: Init { owner: owner, tier: tier as uint8, content: content },
    });
    deployMsg.send(SEND_MODE_REGULAR);

    val log = createExternalLogMessage({
        dest: ExtOutLogBucket { topic: TOPIC_TIER_MINTED },
        body: TierMintedLog { owner: owner, tier: tier as uint8, index: index },
    });
    log.send(SEND_MODE_REGULAR);

    return index;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy RootMessage.fromSlice(in.body);
    match (msg) {
        PaidMint => {
            var st = CollectionStorage.load();
            assert (!st.paused) throw ERR_PAUSED;
            assert (msg.tier == TIER_24H_SKIP || msg.tier == TIER_FOREVER) throw ERR_WRONG_OP;

            val price = msg.tier == TIER_24H_SKIP ? SKIP_24H_PRICE : SKIP_FOREVER_PRICE;

            reserveGramsOnBalance(MIN_COLLECTION_RESERVE, RESERVE_MODE_AT_MOST);
            val usable = in.valueCoins - MIN_COLLECTION_RESERVE - GAS_BUFFER - ITEM_DEPLOY_GAS;
            assert (usable >= price) throw ERR_INSUFFICIENT;
            val excess = usable - price;

            deployItem(st, in.senderAddress, msg.tier, ITEM_DEPLOY_GAS);
            st.economics.nextItemIndex += 1;

            val toRouter = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: price,
                dest: st.router,
                body: RouterForward { queryId: msg.queryId },
            });
            toRouter.send(SEND_MODE_PAY_FEES_SEPARATELY);

            if (excess > 0) {
                val refund = createMessage({
                    bounce: BounceMode.NoBounce,
                    value: excess,
                    dest: in.senderAddress,
                });
                refund.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }

            st.save();
        }

        ReferralClaim => {
            val st = CollectionStorage.load();
            assert (!st.paused) throw ERR_PAUSED;

            val fwd = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: referralAccountDeployDest(st, in.senderAddress),
                value: 0,
                body: ReferralClaimFwd {
                    queryId: msg.queryId,
                    attestation: msg.attestation,
                    signature: msg.signature,
                    signerKey: st.signerKey,
                },
            });
            fwd.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        ReferralApproved => {
            var st = CollectionStorage.load();
            val expectedChild = referralAccountDeployDest(st, msg.claimant).calculateAddress();
            assert (in.senderAddress == expectedChild) throw ERR_NOT_ROOT;

            val nowTs = blockchain.now();
            val elapsed = nowTs - st.economics.lastFreeMintRefillAt;
            val refillPerHour = 1; // 1 per 4 hours, expressed as refillPerSecond below
            val refilled = min(
                st.economics.freeMintBucketCapacity,
                st.economics.freeMintBucketAvailable + elapsed / (4 * 3600)
            );
            assert (1 <= refilled) throw ERR_BUSY;

            st.economics.freeMintBucketAvailable = refilled - 1 as uint16;
            st.economics.lastFreeMintRefillAt = nowTs;

            deployItem(st, msg.claimant, TIER_24H_SKIP, ITEM_DEPLOY_GAS);
            st.economics.nextItemIndex += 1;
            st.save();
        }

        SetRouter => {
            var st = CollectionStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.router = msg.router;
            st.save();
        }

        SetSignerKey => {
            var st = CollectionStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.signerKey = msg.signerKey;
            st.save();
        }

        SetPaused => {
            var st = CollectionStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.paused = msg.paused;
            st.save();
        }

        SetContent => {
            var st = CollectionStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.content = ContentCell {
                collectionContent: msg.collectionContent,
                content24h: msg.content24h,
                contentForever: msg.contentForever,
            };
            st.save();
        }

        ProposeLimits => {
            var st = CollectionStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            st.economics.pendingFreeMintBucketCapacity = msg.freeMintBucketCapacity;
            st.economics.pendingEffectiveAt = (blockchain.now() + TIMELOCK_DELAY) as uint32;
            st.save();
        }

        ApplyLimits => {
            var st = CollectionStorage.load();
            assert (in.senderAddress == st.admin) throw ERR_NOT_OWNER;
            assert (st.economics.pendingEffectiveAt != 0) throw ERR_BUSY;
            assert (blockchain.now() >= st.economics.pendingEffectiveAt) throw ERR_BUSY;
            st.economics.freeMintBucketCapacity = st.economics.pendingFreeMintBucketCapacity;
            st.economics.pendingEffectiveAt = 0;
            st.save();
        }

        RetryForward => {
            var st = CollectionStorage.load();
            if (st.economics.pendingForward > GAS_BUFFER) {
                val amount = st.economics.pendingForward - GAS_BUFFER;
                st.economics.pendingForward = 0;
                st.save();

                reserveGramsOnBalance(MIN_COLLECTION_RESERVE, RESERVE_MODE_AT_MOST);
                val retry = createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    value: amount,
                    dest: st.router,
                    body: RouterForward { queryId: msg.queryId },
                });
                retry.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_WRONG_OP;
        }
    }
}

// Only a bounced RouterForward reaches here (a bounced ReferralClaimFwd bounces to the
// claimant's ReferralAccount, not root; there's nothing to reverse either way — see
// docs/tokenomics.md). Body is small (opcode+queryId, 96 bits) so Only256BitsOfBody already
// carries it whole; no RichBounce needed here unlike RewardVault's larger bounced bodies.
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val originalOp = in.bouncedBody.loadUint(32);
    if (originalOp == 0x80005309) { // RouterForward
        var st = CollectionStorage.load();
        st.economics.pendingForward += in.valueCoins;
        st.save();
    }
}

get fun get_collection_data(): (int, cell, address) {
    val st = CollectionStorage.load();
    return (st.economics.nextItemIndex as int, st.content.collectionContent, st.admin);
}

get fun get_nft_address_by_index(index: int): address {
    val st = CollectionStorage.load();
    return itemDeployDest(st, index as uint64).calculateAddress();
}

get fun get_nft_content(index: int, individualContent: cell): cell {
    return individualContent;
}

get fun royalty_params(): (int, int, address) {
    val st = CollectionStorage.load();
    return (0, 100, st.admin); // placeholder — 0% — see SetContent's comment on metadata
}

get fun routerAddress(): address {
    return CollectionStorage.load().router;
}

get fun adminAddress(): address {
    return CollectionStorage.load().admin;
}

get fun signerKey(): int {
    return CollectionStorage.load().signerKey;
}

get fun isPaused(): int {
    return CollectionStorage.load().paused as int;
}

get fun freeMintBucketState(): (int, int, int) {
    val e = CollectionStorage.load().economics;
    return (e.freeMintBucketCapacity, e.freeMintBucketAvailable, e.lastFreeMintRefillAt);
}

get fun pendingLimits(): (int, int) {
    val e = CollectionStorage.load().economics;
    return (e.pendingFreeMintBucketCapacity, e.pendingEffectiveAt);
}

get fun referralAccountAddressOf(owner: address): address {
    val st = CollectionStorage.load();
    return referralAccountDeployDest(st, owner).calculateAddress();
}

get fun nextItemIndex(): int {
    return CollectionStorage.load().economics.nextItemIndex;
}
