# System Architecture — Four Contracts in Tolk

Expanded descriptions, state layouts, message flows, and failure modes. Tolk syntax follows the current TON docs (`contract` declaration, opcoded structs, `lazy` parsing, `createMessage`); DEX interface details should be re-checked against STON.fi's live docs before implementation, since it's the fastest-moving dependency in the system.

**Single-venue, not dual.** The Router section below targets STON.fi only. The original design routed liquidity 50/50 across STON.fi and DeDust; that's dropped, not deferred — DeDust v2's pool architecture doesn't expose standard jetton get-methods (`get_wallet_address` fails with exit code 11), doesn't surface in generic jetton-holder indexes, and its `get_pool_data` returns internal vault-routing structures that don't match documented DeDust jetton-LP behavior. It's a real, active pool, just not one verifiable or reasoned about through standard tooling. Both DEXs' original liquidity have been withdrawn on mainnet; the live position is STON.fi-only, and this isn't "STON.fi first, DeDust later" — it's single venue, full stop, for the foreseeable future.

---

## Cross-cutting design decisions

Three decisions shape all four contracts and are worth settling before writing any of them.

**Sharded accounts, not dictionaries.** Anywhere the system tracks per-wallet state (slot counts, claim nonces), the naive layout is a `dict` in a single root contract. On TON that serializes every user through one contract's message queue and grows a cell tree that costs more to touch every year. The alternative is one small child contract per wallet, deployed at a deterministic address derived from `stateInit = { code: childCode, data: { owner, root } }`. Writes become parallel, storage rent is paid per-user, and the off-chain oracle can compute any user's address without an index. Both the Registry and the Vault use this pattern.

**Events over polling.** The oracle reads chain state. Rather than polling get-methods across thousands of child contracts, every state-changing handler emits an external-out log via `createExternalLogMessage` with an `ExtOutLogBucket { topic }`. Indexers subscribe by destination address without parsing bodies. Get-methods remain as the authoritative fallback and reconciliation path.

**No atomicity across contracts.** TON has no multi-contract transaction. Every cross-contract call is a separate transaction that may fail, bounce, or arrive out of order relative to sibling messages. Contracts that fan out (Router especially) need an explicit state machine, a `queryId` on every leg, bounce handlers that restore state, and a timeout that lets a stuck cycle be reset. Contracts that fan in need to tolerate duplicates.

Shared file, imported everywhere:

```tolk
// constants.tolk
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
```

---

## 1. Registry — slot ownership accounting

### What it is

The Registry answers exactly one question: *how many shares does this wallet hold?* It knows nothing about tiers, presses, epochs, or rewards. Slot 1 is free and implicit — it is never written to storage, so a wallet that has never interacted with the system still reads as one slot. Additional slots are bought on-chain at a price that escalates with each slot the wallet already owns, and the TON paid is forwarded to the Router.

The escalation is per-wallet, not global. Wallet A buying its fifth slot pays the fifth-slot price regardless of how many slots wallet B holds. This is what makes the sharded layout natural: price depends only on state the child contract already holds.

### Structure

**`SlotRegistry` (root, one instance).** Holds curve parameters, the Router address, the `SlotAccount` code cell, global counters, an admin address, and a pause flag. It does not hold per-wallet data.

**`SlotAccount` (child, one per wallet that has bought at least one extra slot).** Holds `owner`, `root`, `extraSlots`, `totalPaid`. Address derived deterministically from `(code, owner, root)`.

Critically, the child stores **extra** slots only. Effective slots = `1 + extraSlots`. The free slot is an invariant of the read path, never a row in state. A wallet with no deployed `SlotAccount` reads as exactly one slot, which means the oracle must treat "account not found" as `slots = 1` rather than as an error.

### Purchase flow

```
user wallet ──BuySlot{queryId}──▶ SlotRegistry (root)
                                       │  validates not paused, forwards value
                                       ▼
                                  SlotAccount (deploy-if-absent via stateInit)
                                       │  computes price from its own extraSlots
                                       │  asserts attached value ≥ price
                                       │  extraSlots += 1
                                       ├──price──▶ Router
                                       ├──excess──▶ user
                                       └──log(TOPIC_SLOT_BOUGHT)──▶ indexers
```

Pricing is evaluated in the child, not the root, because the child is the only contract that knows the current count. This removes the read-then-write race entirely — there is no window in which two concurrent purchases can both quote the same price. The cost is that the user cannot know the exact price from the root alone; the client quotes from the child's get-method and attaches a margin, and the child refunds the excess.

### The price curve

Integer arithmetic only, and bounded gas. A geometric curve `p_n = base · (num/den)^(n-1)` is the usual intent ("each one costs more than the last on an escalating curve"), but naive exponentiation is an unbounded loop over `n`. Three viable forms:

| Form | Expression | Properties |
|---|---|---|
| Geometric, bounded | `base · numᵏ / denᵏ`, loop capped by `MAX_SLOTS` | Smooth escalation, gas bounded by the cap, overflow risk at large `k` |
| Quadratic | `base · n²` | Cheap, no loop, gentler than geometric at high `n` |
| Table | `prices[n]` from a fixed array in root, last entry repeats | Fully arbitrary shape, exact, no math risk; requires a migration to change |

A hard `MAX_SLOTS` is required regardless of form — it bounds the loop, bounds the `coins` overflow surface, and caps how much any single wallet can concentrate. Round up to whole nanotons so rounding never favors the buyer.

Curve parameters should be immutable or timelocked. A mutable curve means a quote fetched at time *t* can be invalidated before the transaction lands, which produces confusing failures and a live griefing surface.

### Tolk sketch

```tolk
import "constants.tolk"

struct (0x5101) BuySlot     { queryId: uint64 }
struct (0x5102) BuySlotFwd  { queryId: uint64; buyer: address; curve: CurveParams }
struct (0x5103) SetPaused   { paused: bool }

struct CurveParams {
    basePrice: coins
    num: uint16
    den: uint16
    maxSlots: uint8
}

struct RootStorage {
    admin: address
    router: address
    accountCode: cell
    curve: CurveParams
    paused: bool
    totalExtraSlots: uint64
}

type RootMessage = BuySlot | SetPaused

contract SlotRegistry {
    storage: RootStorage
    incomingMessages: RootMessage
}

fun RootStorage.load() { return RootStorage.fromCell(contract.getData()) }
fun RootStorage.save(self) { contract.setData(self.toCell()) }

fun accountStateInit(st: RootStorage, owner: address): ContractState {
    return {
        code: st.accountCode,
        data: AccountStorage {
            root: contract.getAddress(),
            owner: owner,
            extraSlots: 0,
            totalPaid: 0,
        }.toCell()
    }
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy RootMessage.fromSlice(in.body);
    match (msg) {
        BuySlot => {
            val st = lazy RootStorage.load();
            assert (!st.paused) throw ERR_PAUSED;

            val fwd = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: { stateInit: accountStateInit(st, in.senderAddress) },
                value: 0,
                body: BuySlotFwd {
                    queryId: msg.queryId,
                    buyer: in.senderAddress,
                    curve: st.curve,
                }
            });
            fwd.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
        SetPaused => { /* admin-gated */ }
        else => { assert (in.body.isEmpty()) throw ERR_WRONG_OP }
    }
}
```

The child's handler computes the price, asserts sufficiency, increments, and splits the value three ways — Router, refund, and a small retained reserve for storage rent (`reserveToncoinsOnBalance` before the outgoing sends, so the account never rots out of existence).

### Failure semantics

If the Router forward bounces (Router uninitialized, or throws), the slot has already been granted. That is the correct ordering: the user paid, the user gets the slot, and the TON returns to the `SlotAccount` where it sits until an admin or keeper re-forwards it. Reversing the slot grant on a Router failure would be worse — it makes user-visible state depend on the health of an unrelated contract. Use `BounceMode.Only256BitsOfBody` and keep a `pendingForward: coins` field for the retry path.

### Get-methods

- On root: `curveParams()`, `routerAddress()`, `accountAddressOf(owner)`, `totalExtraSlots()`
- On child: `slotsOf()` returning `1 + extraSlots`, `nextPrice()`, `totalPaid()`

`accountAddressOf` matters — it lets any client derive the child address without replicating the state-init hashing.

---

## 2. Skip NFT Collections — tier proof

### What they are

Tier status is expressed as NFT ownership rather than a registry entry. Two tiers: a **24h Skip** and a **Forever Skip**. The oracle determines tier by reading holders from chain, so the contracts must be standard-compliant enough that ordinary indexers, wallets, and marketplaces treat them as real NFTs. Mint payment routes through the Router identically to slot purchases.

Standard surface: TEP-62 (NFT), TEP-64 (metadata), TEP-66 (royalties). Get-method names must match the standard byte-for-byte — `get_nft_data`, `get_collection_data`, `get_nft_address_by_index`, `get_nft_content`, `royalty_params` — or wallets will render the items as unknown assets.

### One collection or two?

| | Two collections | One collection, tier field per item |
|---|---|---|
| Oracle read | Two address filters, no body parsing | One filter, must read each item's tier |
| Marketplace UX | Two distinct collections, clean floors | Mixed floor, tier hidden in traits |
| Deploy cost | Two collection contracts | One |
| Index space | Independent counters | Shared counter |

Two collections is the better fit here specifically because the oracle's job becomes a pure holder-set query per address with no per-item state read. That advantage compounds when the oracle runs on every press.

### The expiry problem

This is the substantive design issue. NFTs do not expire, but a "24h skip" must. Three models:

1. **Mint-time expiry.** Item stores `mintedAt`; oracle checks `now < mintedAt + 86400`. Simple, but the clock starts at purchase, so a pass bought and held is worthless, and the secondary market is dead on arrival.
2. **Activation expiry.** Item stores `activatedAt: uint32`, initialized to `0`. An `Activate` message from the current owner sets it to `now`. Oracle checks `activatedAt != 0 && now < activatedAt + 86400`. The pass is a tradable voucher until burned into a live window, which is strictly more useful and creates a real secondary market for unactivated passes.
3. **Consumable.** Item is burned on use. Cleanest semantics, but destroys the resale market and loses the on-chain record.

Model 2 is recommended. It costs one extra `uint32` in item storage and one extra message type, and it makes the tier meaningfully ownable rather than a decaying receipt.

**This project uses a repeatable variant of Model 2, not the single-use version as first described above.** The 24h-skip is meant to work like a recurring daily card-swipe: the current owner can call `Activate` at any time — not just once ever — to reset `activatedAt` to `now`, indefinitely, for as long as they hold the item. There is no `assert(activatedAt == 0)` one-time guard. This was confirmed directly after the first build gated `Activate` to a single lifetime use, which was wrong: resetting early costs the holder nothing and touches no shared resource, so there's no reason to restrict frequency. The tradable-voucher property Model 2 was chosen for still holds — an item can sit unactivated (and be sold as such) indefinitely — it just isn't consumed by the first activation.

The Forever item needs a separate decision: **transferable or soulbound (TEP-85)**. Transferable means the tier is an asset with a floor price and speculative demand; soulbound means the tier cannot be resold and the mint revenue is the only revenue. Transferable is the default assumption unless tier status is meant to be identity-bound.

### Mint flow and index assignment

```
user ──Mint{queryId}──▶ Collection
                            │  index = nextItemIndex++
                            ├──deploy──▶ NftItem{ index, owner, activatedAt: 0 }
                            ├──remainder──▶ Router
                            └──log(TOPIC_TIER_MINTED)
```

The monotonic `nextItemIndex` serializes all mints through the collection's single message queue. At low volume this is fine. If mint bursts are expected, an alternative is deriving the index from `hash(owner, salt)` so items deploy in parallel with no shared counter — at the cost of a non-sequential index space, which some marketplace indexers handle poorly.

Deduct the item deploy cost and a storage reserve before forwarding to the Router, or the collection will slowly bleed its own balance funding item deployments.

### Free (referral) mints need their own on-chain cap

This project adds a second mint path alongside the paid one: a free mint gated by a signed oracle attestation ("wallet X has 5 valid referrals"), since referral validity depends on off-chain press-history data the collection contract can't check itself.

That path has no analogue to the Vault's per-wallet elapsed-time bound (see the Vault section) — a Forever item is transferable, so a forged referral attestation mints a real asset that can be sold immediately on a marketplace, without ever touching the Vault's balance or being slowed by any cap designed to protect the 9B pool. A compromised referral-signer key can mint an unbounded number of these; nothing about the Vault's defenses applies here, because this path doesn't draw from the Vault at all.

The collection contract needs its own explicit on-chain rate cap on the free-mint path — the same token-bucket shape as the Vault's (`capacity` / `refillRate` / `lastRefillAt`, checked in the `ClaimReferral` handler before minting), sized to whatever a realistic legitimate referral rate looks like. This is a required structural piece of the collection contract, not just a parameter — the free-mint handler is incomplete without it.

This vulnerability is unrelated to the Vault's claim-draining risk, which raised the question of whether the referral-attestation signer needs to be a separate key from the Vault's claim signer. The actual decision (made directly, not derived here): reuse the Vault's oracle key for referral attestations too. `signerKey` is a config value each contract holds its own copy of — `SkipCollection`'s slot is already structurally independent of the Vault's, so nothing prevents rotating to a distinct key later — and doing so is a one-line admin `SetSignerKey` call if it's ever actually warranted, not a redeploy. The free-mint rate cap above is the real, load-bearing fix for the exposure described; key separation is a cheap additional layer that turned out not to be worth the operational cost of running two keys for a risk the cap already bounds.

### Tolk sketch

```tolk
struct ItemStorage {
    index: uint64
    collection: address
    owner: address
    content: cell
    activatedAt: uint32     // 0 = unactivated; 24h collection only
}

struct (0x5f5cc3f1) Transfer {              // TEP-62 opcode
    queryId: uint64
    newOwner: address
    responseDest: address
    customPayload: cell?
    forwardAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

struct (0x5201) Activate { queryId: uint64 }

type ItemMessage = Transfer | GetStaticData | Activate

fun onInternalMessage(in: InMessage) {
    val msg = lazy ItemMessage.fromSlice(in.body);
    match (msg) {
        Activate => {
            var st = lazy ItemStorage.load();
            assert (in.senderAddress == st.owner) throw ERR_NOT_OWNER;
            // repeatable, not single-use — see "The expiry problem" above
            st.activatedAt = blockchain.now();
            st.save();
        }
        // ... standard TEP-62 handlers
    }
}

get fun get_nft_data(): (bool, int, address, address, cell) {
    val st = lazy ItemStorage.load();
    return (true, st.index, st.collection, st.owner, st.content);
}
```

Expose `activatedAt` through an additional non-standard getter (`activationState()`) rather than overloading `get_nft_data`, so standard tooling stays unbroken.

---

## 3. Buyback-and-Lock Router — the value sink

### What it is

Every TON that enters the system — slot purchases and NFT mints alike — lands here. The Router converts that TON into permanently locked liquidity: swap a portion for the reward token, pair the remainder back with it, deposit into the STON.fi pool, and route the resulting LP tokens to the Locker. The economic claim is that no purchase can ever be extracted; it can only deepen the floor.

**LP-token policy — settled, not an open question.** Every cycle's resulting LP token routes to the Locker. Never burned. There is no fee-claim function anywhere in the Router or Locker, and none is planned — an admin-callable "withdraw accrued trading fees" function is exactly the kind of narrow, easy-to-justify admin surface that quietly reintroduces trust into a system whose entire pitch is that no one can extract value. Simplicity and a zero-admin-trust surface on this specific path outweigh whatever yield a fee-claim mechanism would otherwise recover. Trading fees the pool position accrues stay inside the LP position and compound it — this is a real strengthening of the locked-liquidity claim, not just an implementation detail, since it means locked value grows over time from principal *and* accumulated fees, not principal alone.

This is the most complex contract in the system, and the complexity is not in the arithmetic. It is that a "buyback" is several sequential cross-contract calls against a third-party DEX, none of which can be rolled back, executed by a contract that cannot read the pool's price synchronously.

### Batch, do not stream

The described design executes a buyback on every incoming purchase. This should change. Per-purchase execution means:

- Every small purchase pays the full multi-leg gas cost of a swap and an LP deposit
- Small swaps eat proportionally larger price impact and fixed DEX fees
- Every purchase mints a dust LP position, and dust rounding is lost on each one
- The Router is mid-cycle almost continuously, so a stuck leg blocks everything behind it

Instead: **accumulate, then crank.** The Router holds incoming TON and runs a cycle when either (a) the accumulated balance crosses a threshold, or (b) a permissionless `ExecuteCycle` message arrives and the minimum interval has elapsed. Pay the cranker a small fixed bounty from the cycle so the crank is self-sustaining and does not depend on a team-run keeper. Purchases become a single cheap `Deposit` message; the expensive machinery runs on its own schedule.

This changes the invariant from "every purchase deepens liquidity" to "every purchase is irrevocably committed to deepening liquidity," which is the same guarantee at a fraction of the cost.

### Slippage — the hard constraint

A swap without `minOut` is free money for a sandwicher, and the loss is permanent because the shortfall is locked as LP. But the Router cannot read pool reserves — TON get-methods are not callable cross-contract during execution. Options:

| Approach | Mechanism | Trade-off |
|---|---|---|
| Signed quote | Cranker submits `minOut` + `deadline` signed by the oracle key | Works, but reintroduces key trust into the "trustless" leg |
| On-chain floor | Router stores a conservative floor price, updated slowly by admin | No per-cycle key dependency, but stale floors either block cycles or under-protect |
| Reserve mirror | A separate contract mirrors pool reserves via periodic DEX callbacks | Most robust, most infrastructure |
| `minOut = 0` | None | Unacceptable at any meaningful cycle size |

Signed quote with a short deadline is the practical starting point, with the signature checked against a key that is *distinct* from the Vault's claim-signing key. Blast radius separation matters here — a compromised quote key can bleed the buyback; a compromised claim key can drain the vault; they should never be the same key.

### DEX integration notes

STON.fi's config lives in storage, not hardcoded constants, so a pool migration is a parameter change rather than a redeploy.

- TON-side swaps go through the pTON proxy wallet; the swap itself is a jetton transfer to the STON.fi router with a forward payload carrying swap parameters.
- The Router needs: the pTON wallet address, STON.fi's router address, the specific TONkAS/TON pool address, and its own jetton wallet for the reward token.

### LP token routing

The naive path is: STON.fi mints LP to the Router → Router transfers LP to the Locker. That is an extra hop, an extra gas payment, and an extra failure state in which LP sits unlocked in the Router. If STON.fi allows specifying the LP recipient at deposit time, set it to the Locker directly and the LP never touches the Router. If the recipient cannot be specified, the Router must handle the incoming LP `transfer_notification` and forward — which means a handler that can distinguish LP arrivals from reward-token arrivals by sender jetton wallet address.

### Cycle state machine

```
Idle
 └─ ExecuteCycle ──▶ SwapPending   (queryId, deadline)
       └─ token received ──▶ Depositing  (STON.fi add-liquidity)
             └─ ack/LP ──▶ Idle  (emit TOPIC_CYCLE_DONE)
```

Every transition carries the `queryId`; messages with a stale `queryId` are dropped rather than processed. Every leg has a bounce handler that returns the cycle to `Idle` and leaves funds accumulated for the next attempt. A `stuckAfter` timestamp lets anyone reset a cycle that has been non-`Idle` past the deadline — without it, one failed DEX call freezes the value sink permanently.

Dust from imperfect deposit ratios comes back as excess and should simply be left on the Router balance to fold into the next cycle. Do not attempt to zero it out.

```tolk
struct RouterStorage {
    admin: address
    locker: address              // immutable, no setter — see "Built" note below
    stonfiRouter: address        // immutable, no setter
    stonfiTonkasWallet: address  // immutable, no setter — STON.fi's own wallet for TONkAS,
                                   // used both as the swap's askJettonWallet and as the
                                   // provide_lp counterpart address for the TON leg
    ptonWallet: address          // immutable, no setter — STON.fi's own wallet for pTON
    quoteSignerKey: uint256
    rewardJettonWallet: address  // settable via admin — same chicken-and-egg as Vault's jettonWallet
    paused: bool
    accumulated: coins
    minCycleValue: coins
    minCycleInterval: uint32
    crankBountyBps: uint16       // basis points, not a flat amount — see tokenomics.md
    state: uint8                 // 0=Idle, 1=Swap, 2=Depositing
    activeQueryId: uint64
    stuckAfter: uint32
    lastCycleAt: uint32
    // plus pendingPairAmount/pendingMinLpOut (in-flight cycle context) and the usual
    // pendingMinCycleValue/pendingMinCycleInterval/pendingCrankBountyBps/pendingEffectiveAt
    // timelock fields, same asymmetry rule as the Vault
}
```

**Built.** `contracts/Router.tolk`, tested in `tests/Router.spec.ts` against the verified
addresses in `docs/tokenomics.md`. Two design points resolved during the build, beyond
what's sketched above:

- `locker`, `stonfiRouter`, `stonfiTonkasWallet`, and `ptonWallet` are set once at deploy
  and have **no setter anywhere in the contract** — deliberately, not an oversight. A
  mutable "redirect where deposits or LP go" admin call would reintroduce exactly the
  admin-trust surface the LP-token-policy disclosure above says doesn't exist. If STON.fi
  ever migrates addresses, that's a new Router deployment, the same "no upgrade path"
  philosophy as the Locker itself.
- STON.fi's real swap/provide_lp forward-payload TL-B is transcribed field-for-field from
  `ston-fi/dex-core-v2`'s `contracts/common/op.fc` and `ston-fi/sdk`'s `BaseRouterV2_1.ts`
  / `PtonV2_1.ts`, not reverse-engineered — see `Router.tolk`'s header comment. The
  `provide_lp` payload's `receiver` field is where the Locker gets set directly, confirming
  the "LP token routing" section above: the LP never touches this contract.

---

## 4. Reward Vault — emission and payout

### What it is

The Vault custodies the 9B reward allocation and is the only contract that can move it. It tracks cumulative tokens mined (which drives the halving schedule), derives the current epoch's emission ceiling, verifies signed claim attestations produced by the off-chain oracle, and pays out. The per-claim cap and daily payout ceiling exist as backstops: if the signing key is compromised, they bound the damage to a rate rather than the full balance.

### Accounting is internal, never balance-derived

`cumulativeMined` must be a storage field the Vault increments itself. Deriving emission progress from the jetton wallet balance is exploitable — anyone can donate tokens to the wallet and shift the halving schedule. The balance is a liquidity check, not an accounting source.

### Halving on cumulative, not time

`epoch = cumulativeMined / halvingInterval`, and the per-unit emission rate for that epoch is `baseRate >> epoch`. The edge case is a claim that straddles a halving boundary. Two handlings:

- **Clamp:** pay only up to the boundary, let the claimant re-claim the remainder. Simple, but produces a confusing partial payout.
- **Split:** pay the pre-boundary portion at the old rate and the remainder at the new rate in one transaction. Correct, and the loop is bounded because a single claim cannot plausibly cross more than one or two boundaries — enforce a hard cap of *k* boundary crossings per claim and reject beyond it.

Split is the right default. The bounded-crossing cap is what keeps the loop's gas deterministic.

### Attestation format and replay

The signed payload must be domain-separated. A signature that says only "pay 5000 to Alice" is replayable across every deployment, every testnet fork, and every subsequent claim.

```tolk
struct ClaimAttestation {
    magic: uint32           // domain tag, e.g. 0x52565431
    vault: address          // this vault specifically
    claimant: address
    amount: coins
    nonce: uint64           // strictly increasing per claimant
    validUntil: uint32
}
```

Verification: `isSignatureValid(attestation.toCell().hash(), signature, storage.signerKey)`, then check `magic`, `vault == contract.getAddress()`, `now < validUntil`, and `nonce > lastNonce` for that claimant.

Per-claimant nonces live in a **`ClaimAccount` child contract**, same sharded pattern as the Registry — one per claimant, deterministic address, holding `lastNonce`, `lifetimeClaimed`, and **`lastClaimTime: uint32`**. A single nonce dictionary in the Vault would serialize all claims and grow without bound.

### Per-wallet claim bound — provable, not rate-limited

A flat `maxPerClaim` constant does not bound worst-case damage from a compromised signer key. As long as `maxPerClaim` is smaller than the daily bucket capacity, an attacker just submits `ceil(bucketCapacity / maxPerClaim)` forged claims and extracts the same total regardless of what `maxPerClaim` is set to — the constant only changes how many transactions it takes, not how much gets out.

The fix is to bound each claim against something the Vault tracks itself, not against a round number:

```
hoursSinceLastClaim   = (now - claimAccount.lastClaimTime) / 3600
epoch                 = cumulativeMined / halvingInterval
cappedCeiling         = (baseRate >> epoch) * 2          // pure function of on-chain state, no oracle input
maxClaimable          = hoursSinceLastClaim * cappedCeiling
assert(attestation.amount <= maxClaimable) throw ERR_CAP_EXCEEDED
```

`cappedCeiling` is the network-wide hourly ceiling at the 2x participation-multiplier cap for the current epoch — computed entirely from `cumulativeMined`, which the Vault already owns. A forged attestation claiming more than real elapsed time could ever have produced, even under maximum theoretical network-wide participation, is rejected at verification time regardless of the signature. This makes total system-wide worst-case drain a function of elapsed real time, not of how many forged claims get submitted — closing the exploit rather than slowing it down.

This bound is intentionally loose per-wallet (it uses the *network-wide* ceiling, not that wallet's actual share of it), because tightening it further would require the Vault to know a wallet's live slot count, which lives in the Registry and isn't cheaply readable cross-contract. Treat it as the hard safety ceiling, not a substitute for the oracle attesting accurate amounts.

### Rate limiting — token bucket, sized for backlog not just steady state

With the per-wallet bound above in place, the bucket's job changes: it's no longer the only thing standing between a compromised key and unbounded drain (the per-wallet bound already makes that impossible), so it can — and should — be sized generously enough to absorb **legitimate** bursts without false-positive-blocking real users.

The failure mode to design around: nothing requires anyone to claim on a fixed cadence. A handful of Forever-tier holders who haven't claimed in weeks, all claiming the same day, can legitimately exceed a bucket sized only for continuous steady-state throughput — that's real backlog, not fraud.

```
elapsed   = now - lastRefillAt
available = min(capacity, available + refillRate * elapsed)
assert(amount <= available)
available -= amount
lastRefillAt = now
```

A "daily ceiling" implemented as `dayIndex = now / 86400` with a counter reset on rollover has a known flaw on top of the backlog problem: an attacker drains the full cap at 23:59 and again at 00:01, achieving 2× the intended rate in two minutes. The token bucket above avoids that too — the rate limit holds continuously rather than per-calendar-day.

Split the two concerns instead of conflating them into one number:
- **`refillRate`** — set to the intended long-run average payout rate (this is what actually caps sustained emission over time).
- **`capacity`** — set well above one day of `refillRate`, sized against a realistic backlog scenario (e.g. total plausible Forever-holder count × a multi-week claim gap), so it absorbs bursts of legitimate backlog rather than reverting them.

Because the per-wallet bound already makes unbounded drain impossible, running the bucket dry is an expected occasional event under legitimate backlog, not evidence of compromise — it should throttle (claims wait for refill) rather than trip a `paused` state. Reserve `paused` for a genuinely different signal: sustained multi-day exhaustion, or a pattern of claims that fail the per-wallet bound, which *is* evidence of a live attack.

### Key separation and emergency response

Three distinct authorities, and collapsing any two of them defeats the backstops:

| Authority | Holder | Powers |
|---|---|---|
| Signer key | Hot, on the oracle | Sign attestations only |
| Admin key | Cold / multisig | Pause, rotate signer key |
| Governance | Multisig + timelock | Raise caps, change halving params |

The asymmetry that matters: **pausing and key rotation must be immediate; raising any limit must be timelocked.** Otherwise an attacker who takes the admin key raises the cap to infinity and drains in one transaction — the caps become decorative. The timelock is what converts a compromise into a detectable event with a response window.

### Payout and bounce

Payout is a jetton transfer from the Vault's jetton wallet. State is updated before the transfer, so a failed transfer must be reversed on bounce — restore `cumulativeMined`, the bucket balance, and the claimant's nonce. Use `BounceMode.RichBounce` here specifically: the reversal needs the full original body to know which claimant and amount to restore, and claims are infrequent enough that the higher gas cost is irrelevant.

Set `forwardTonAmount: 0` on the transfer unless the claimant needs a notification; it halves the downstream message cost.

```tolk
struct VaultStorage {
    admin: address
    signerKey: uint256
    jettonWallet: address
    claimAccountCode: cell
    cumulativeMined: coins
    halvingInterval: coins
    baseRate: coins
    maxPerClaim: coins          // secondary flat ceiling; primary bound is per-wallet hoursSinceLastClaim * cappedCeiling
    bucketCapacity: coins
    bucketAvailable: coins
    bucketRefillRate: coins     // per second
    lastRefillAt: uint32
    paused: bool
    pendingParamChange: cell?   // timelocked
}
```

---

## Build order and verification

1. **Registry** first — it exercises the sharded-child pattern, deterministic addressing, and Router forwarding with nothing else depending on it. Get this right and the Vault's `ClaimAccount` is a copy.
2. **Vault** second — self-contained, signature-heavy, testable entirely in sandbox with a mock jetton. The security properties here are the ones with the largest downside.
3. **NFT collections** third — mostly standard-conformance work; the only novel piece is activation.
4. **Router** last, and against real DEX code. Sandbox mocks will not surface the integration bugs; deploy the actual STON.fi contract code cells into the test environment, or run the integration phase on testnet against live deployments.

Tolk-specific tooling notes: the `contract` declaration drives ABI export and TypeScript wrapper generation, so the Blueprint test suite gets typed message constructors for free — use them rather than hand-rolling cell builders in tests, since hand-rolled builders test your test code rather than the contract. Use `lazy` on every storage load and message parse; on contracts with wide storage structs like the Router, the skipped-field optimization is a meaningful share of the gas. Keep opcodes in one shared constants file with a namespacing scheme, because a collision between two contracts' opcodes is silent at compile time and catastrophic at runtime.

Invariants worth asserting in tests:
- Registry: `slotsOf() >= 1` for every address, including undeployed ones
- Registry: sum of all `SlotAccount.totalPaid` equals total TON received by Router from the Registry path
- Vault: `cumulativeMined` is monotonic and never exceeds 9B
- Vault: no sequence of valid attestations can exceed `bucketCapacity` within any 86400-second window
- Router: `state != Idle` implies `now < stuckAfter`, checked after every message
- Router: TON in equals TON out plus balance, across a full cycle, within gas tolerance
