# Token & liquidity state

Working notes on the reward token's current on-chain position, resolved
launch parameters, and the plan for migrating it into the four-contract
system described in `docs/architecture.md`. This is operational status, not
a spec — update it as real numbers move.

## Current mainnet state

- Reward token (frog-themed meme token, mineable via the Telegram game) is
  **already live on mainnet**, submitted to the TON assets GitHub repo for
  verification (not yet approved as of this writing).
- Jetton master: `EQBF6stfWMsDvkEOm2pqKs0C4rU0RRU_fdRDmIgo_sDVpShl`, 9 decimals.
  Verified on-chain: `active`, total supply **69,696,969,696** tokens.
- Liquid on **two DEXes** (STON.fi, DeDust), each reportedly ~30B tokens +
  15+ TON. DeDust pool `EQAamREx6V2Mtx8A9AOku9tYUXjJF2xvKypLc0OVvRIUX7S1`
  confirmed on-chain: `active`, balance 15.64 TON — matches the "15+ TON"
  figure. STON.fi pool address not yet confirmed (see Blocking, below).
- A further **10B tokens held directly** (not in a pool) in dev wallet
  `UQDZlnNRydIutcTUJFgm6Mggnu79-JIzpr1uoMg9qqW7OE4J` (confirmed active), of
  which **9B is earmarked for the game's Reward Vault**, transferred in at
  launch.
- A handful of buys have already happened directly against the pool, outside
  the game — expected and fine, the game isn't the only entry point.

## The pitch

Users pay a small TON fee to register a wallet as eligible, then mine by
pressing a button hourly, once a day (24h-skip NFT), or never again (Forever
NFT). Everyone active in a period splits a fixed reward budget pro-rata —
mining-difficulty style, not a fixed payout per press. Every TON spent on
upgrades or skip NFTs buys back the token and deepens the same locked
liquidity the game pays out of, so playing the game grows its own reward
source.

**Anti-rug guarantees:**
- LP Locker has no withdraw function and no upgrade path anywhere in its
  code — not a permission that could be revoked later, the exit is
  structurally absent.
- Every buyback's resulting LP token routes into the same Locker — the
  guarantee only strengthens as the game grows.
- Reward emission is hard-capped at the 9B allocation via fixed epoch
  budgets.
- The off-chain oracle only signs claims; it cannot move funds itself, only
  certify facts the Vault independently checks before paying.

**Caveat (not a contract concern):** charging a fee for participation in a
system that pays out a tradable token can draw securities/gambling-law
scrutiny in some jurisdictions regardless of contract quality — worth a real
legal read before mainnet launch.

## How mining works (epoch model)

Each hourly epoch has a fixed base budget (see emission schedule below),
scaled by a participation multiplier, split pro-rata across every **active
slot** that epoch:

- **Hourly slot** — active only for the epoch you pressed in.
- **24h-skip NFT slot** — one press marks the slot active for the next 24
  consecutive epochs.
- **Forever NFT slot** — always active, no interaction required.

All slots earn the same pro-rata share when active regardless of tier; tier
only controls how often you must act to stay active. Extra slots (escalating
TON price) just mean more shares in the same split.

## Migration plan

1. Build and fully exercise all four contracts (Registry, NFT collections,
   Router, Vault) on **testnet** first.
2. Once verified, on **mainnet**: pull the reward token back out of both
   existing DEX liquidity pools.
3. Keep only enough TON (from what comes out of the pools) to cover deploying
   the remaining contracts — the rest is not meant to be extracted for any
   other purpose.
4. Re-deploy liquidity through the Router/Locker path so it becomes
   permanently locked LP under the new system.

**Nothing here is being executed yet** — this is the target sequence once
testnet is signed off.

---

## Resolved launch parameters

### Registry
- Jetton master: `EQBF6stfWMsDvkEOm2pqKs0C4rU0RRU_fdRDmIgo_sDVpShl` (9 decimals)
- Slot price curve: geometric — `price(n) = 1 TON × 1.15^n`, `MAX_SLOTS = 100`
- Admin: multisig `EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE` (confirmed active on-chain)

### Vault
- Lifetime allocation: 9,000,000,000 tokens, held in dev wallet
  `UQDZlnNRydIutcTUJFgm6Mggnu79-JIzpr1uoMg9qqW7OE4J` until transferred in at
  launch
- Halving interval: every 1B tokens mined (cumulative-supply checkpoint, not
  time-based)
- Base emission rate by epoch (halving ~doubles the time-to-next-billion at
  baseline pace):

  | Tokens mined | Base rate / hr | ~Time at baseline pace |
  |---|---|---|
  | 0 – 1B | 456,621 | ~3 months |
  | 1 – 2B | 228,311 | ~6 months |
  | 2 – 3B | 114,155 | ~1 year |
  | 3B – 9B | *(remaining 6 epochs not yet given — assumed to keep halving unless told otherwise)* | |

  At epoch 0 the true floor on mining the first billion — under maximum
  theoretical network-wide participation sustained every hour, capped
  multiplier included — is **~1,095 hours / ~45.6 days / ~6.5 weeks**, not
  ~3 months. The ~3-month figure is the typical-pace projection (multiplier
  near 1x); ~6.5 weeks is the bounded worst case. It's a known floor, not
  open-ended, because the multiplier's *effect* is capped at 2x rather than
  the raw coefficient running unclamped.

- Reward formula: `perSlotReward = min(baseHourlyCeiling(epoch) × (1 + 0.001×M), baseHourlyCeiling(epoch) × 2) ÷ N`
  — `M` = unique active miners that hour, `N` = total active slots that hour,
  multiplier capped at 2x. Note this means the epoch budget is not strictly
  fixed — high sustained `M` compresses the whole halving timeline and the
  ~2–3 year runway estimate. The 9B lifetime cap holds regardless, since
  that's enforced by `cumulativeMined` directly, not by per-epoch pacing.
- **Per-claim bound: derived, not a flat constant.** A flat cap doesn't bound
  worst-case damage from a compromised signer key — as long as the flat cap
  is below the daily bucket capacity, an attacker just submits more forged
  claims to reach the same daily ceiling regardless of the constant's value.
  Instead the Vault computes, entirely from state it owns:
  `maxClaimable(wallet) = hoursSinceLastClaim(wallet) × (baseRate(currentEpoch) × 2)`
  — the `ClaimAccount` child tracks `lastClaimTime` per wallet; any
  attestation claiming more than real elapsed time could ever have produced,
  even under max theoretical participation, is rejected regardless of
  signature validity. See `docs/architecture.md`'s Vault section for the full
  verification order. A flat `maxPerClaim` constant is kept as a secondary,
  much looser floor purely as defense in depth.
- **Daily bucket: sized for backlog, not just steady state.** Nothing forces
  claim cadence, so wallets with weeks of unclaimed backlog claiming the same
  day is legitimate, not fraud — a bucket sized only for continuous
  steady-state throughput (the original 25,000,000/day figure) would
  false-positive-block real users. Since the per-wallet bound above already
  makes unbounded drain impossible on its own, the bucket's role shifts to
  smoothing legitimate bursts: `refillRate` stays pinned to the intended
  long-run average payout rate, but `capacity` should be raised well above
  one day of `refillRate` — **open decision: what's a realistic worst-case
  backlog scenario (max plausible Forever-holder count × max plausible
  claim gap) to size `capacity` against?** Running the bucket dry should
  throttle (claims wait for refill), not flip a hard `paused` state — reserve
  `paused` for sustained multi-day exhaustion or repeated per-wallet-bound
  failures, which are actual attack signals.
- Oracle signer key (claims only): not yet built — ship with placeholder
  pubkey, admin-gated (multisig) `setOraclePubkey` rotation. **Separate key**
  from the NFT referral signer, below.
- Admin: same multisig as Registry

### Skip NFT Collections
- 24h-skip: 5 TON, or earned via 5 valid referrals
- Forever: 10 TON
- Forever is transferable (not soulbound)
- Metadata: placeholder for build, real art/JSON swapped in before mainnet
- Two mint paths into the same collection: paid (immediate, tradable) and
  referral-claim (free/gas-only, requires signed oracle attestation)
- Referral validity: counts once the referred wallet has registered *and*
  logged its first press — tracked off-chain by the oracle
- **Free-mint path needs its own on-chain rate cap.** This path has no
  analogue to the Vault's per-wallet elapsed-time bound, and the Vault's caps
  don't protect it — it never touches the Vault's balance. A forged referral
  attestation mints a real transferable Forever NFT, sellable immediately on
  a marketplace, with no limit on how many a compromised key could sign. The
  collection contract needs its own token-bucket (same shape as the Vault's:
  `capacity` / `refillRate` / `lastRefillAt`) checked in the `ClaimReferral`
  handler before minting — this is a required piece of the contract, not a
  tunable. **Open decision: what free-mints-per-day cap is realistic** for
  the actual expected referral volume?
- Referral attestation signer: **separate key from the Vault's claim
  signer** — the two vulnerabilities are unrelated (bounded token drain vs.
  unbounded free-mint-and-sell), so a single compromised key must not be able
  to hit both. Cheap to run both on the same oracle Worker.

### Buyback-and-Lock Router
- Pools: one on STON.fi, one on DeDust — every buyback splits 50/50 across both
- DeDust pool: `EQAamREx6V2Mtx8A9AOku9tYUXjJF2xvKypLc0OVvRIUX7S1` (confirmed active)
- STON.fi pool: **still needed** — have the domain `lambo-liquidity-pool.ton`
  only, need the raw contract address
- Cycle threshold: whichever hits first — 10 TON accumulated, or 6 hours elapsed
- Cranker bounty: 1.5% of the batched amount, permissionless
- Quote-signer key: not yet built — placeholder pubkey + rotation, separate
  from the Vault/referral oracle key
- Admin: same multisig as Registry/Vault

## Resolved: what the earlier flagged concerns turned into

The three items flagged in the previous pass were run through the actual
numbers rather than eyeballed, which changed two of the three conclusions:

1. **Per-claim cap** → not "pick a better constant," a flat cap can't work
   as a backstop at all (see derivation above) — replaced with the
   per-wallet `hoursSinceLastClaim × cappedCeiling` bound.
2. **Multiplier vs. "fixed" budget** → confirmed as a real effect (true floor
   is ~6.5 weeks, not ~3 months) but not a safety issue — the 9B cap holds
   independent of pacing. Timeline note updated above.
3. **Shared oracle key** → reversed from the earlier "fine to defer" call.
   The referral free-mint path turned out to have *no* bound at all (not
   just a looser one than the Vault), which is a different and worse
   exposure than key-sharing alone — now split into two keys, and the
   free-mint path gets its own on-chain rate cap regardless of the key
   question.

## Still blocking

- STON.fi pool's raw contract address (blocks Router only — Registry, Vault,
  and NFT Collections are fully unblocked and ready to build against the
  values above)
- Remaining Vault emission-schedule rows for epochs covering 3B–9B tokens
  mined (or confirmation the halving pattern just continues to 9B)
- Realistic backlog scenario to size the Vault's bucket `capacity` against
- Realistic referral volume to size the NFT collection's free-mint rate cap
  against
