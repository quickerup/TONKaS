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
- **Liquidity strategy pivoted to single-venue.** The original 50/50
  STON.fi + DeDust split was dropped, not deferred — DeDust v2's pool
  architecture doesn't expose standard jetton get-methods
  (`get_wallet_address` fails with exit code 11), doesn't surface in generic
  jetton-holder indexes, and its `get_pool_data` returns internal
  vault-routing structures that don't match documented DeDust jetton-LP
  behavior. It's a real, active pool, just not one verifiable through
  standard tooling. STON.fi's LP token behaved exactly as documented.
  **Action taken:** both DEXs' original liquidity have been withdrawn. The
  live position is STON.fi-only, TONkAS/TON pair, deposited at the pool's
  live ratio: **32 TON + 1,089,876,600 TONkAS** at deposit time.
- **STON.fi pool address (confirmed on-chain, corrected):**
  `EQAFGrQk5fPoDK-bhjyW89Z_hnaNOAmlOGtEQW1Y1vK8GDFk`. A previous version of
  this doc had `EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt` here —
  that address is real but was mislabeled: it's `token0_wallet_address`,
  the pool's own TONkAS-side jetton wallet, not the pool contract itself.
  Caught because it didn't survive independent verification: TonAPI reports
  its interface as plain `jetton_wallet_v1`, and STON.fi's own asset API
  tagged TONkAS `"no_liquidity"` despite a real deposit having happened.
  The corrected address is triangulated three ways — present in STON.fi's
  own `/v1/pools` listing (`token0_address` = the TONkAS jetton master,
  `router_address` = the confirmed router below) with tag
  `pool:dex_major_version:2`; TonAPI reports its interface as
  `stonfi_pool_v2_const_product` with `get_pool_data`/`get_pool_type`
  get-methods; and a direct on-chain `get_pool_data` call independently
  returns matching `router_address`, `token0_wallet_address` (the
  previously-mislabeled address, now correctly identified as this pool's
  own wallet), and reserves. Live on-chain reserves as of this check:
  **26.060000001 TON / 1,092,014,534.869648923 TONkAS** — drifted from the
  32/1,089,876,600 deposit figures via ordinary trading (consistent with
  the organic-buyer activity noted elsewhere in this doc), same as the
  drift already noted for the live AMM balance above.
- Of the ~58.47B tokens that didn't fit into the single-pool deposit ratio,
  **~57,468,162,303.42 tokens (~57.47B) were burned** — sent to the TON
  zero/null address, confirmed on-chain. This was a deliberate operational
  call: burning achieves permanent removal from circulating supply without
  spending mainnet gas deploying and routing through the LP Locker contract
  for a plain (non-LP) balance that has no reason to ever move again. This
  is documented as a **second anti-rug pillar** alongside the locked LP
  position — see "Anti-rug guarantees" below.
- **Developer / Founder Reserve wallet:**
  `UQDZlnNRydIutcTUJFgm6Mggnu79-JIzpr1uoMg9qqW7OE4J` (confirmed active),
  originally holding **10,000,000,000.000002137 tokens**, of which
  **9,000,000,000 is earmarked for the game's Reward Vault** (transferred in
  at launch) and the remaining **~1,000,000,000.000002 was the founder's
  discretionary reserve** (the ~1B figure referenced elsewhere in this doc),
  intended for operational uses such as paying a future dev team.
  Correction from an earlier draft of this doc: a different wallet
  (a small early organic buyer, folded into the bullet below) was briefly
  mislabeled as "the founder reserve" based on a coincidental balance match;
  this wallet — the same one earmarked for the Vault — is the correct one.
  **Update, verified on-chain:** the founder has since deposited part of the
  discretionary reserve into the STON.fi pool and burned the resulting LP
  tokens too. Exact on-chain deltas (re-queried via the same holders
  endpoint): the wallet's balance dropped from 10,000,000,000.000002137 to
  **9,976,533,839.619988291** (−23,466,160.380013846 tokens), and the STON.fi
  pool's balance rose by the identical amount — confirming the deposit came
  from this wallet. Net effect: the 9B Vault earmark is untouched, and the
  discretionary founder reserve now stands at **~976,533,839.62 tokens
  (~976.53M / ~0.977B)**, down from the original ~1B. This further increases
  locked liquidity depth beyond the initial single-pool deposit and reduces
  the outstanding discretionary reserve below its original figure — the same
  "second anti-rug pillar" logic as the burn, applied incrementally as the
  founder chooses to deploy more of the discretionary reserve this way.
- A handful of buys have already happened directly against the pool, outside
  the game — expected and fine, the game isn't the only entry point. **Three**
  such organic-buyer wallets are visible in the jetton's holder list (one —
  holding ~1B tokens — is the wallet briefly mislabeled as "founder reserve"
  above; confirmed by the founder to be an unrelated early buyer, not a
  developer-controlled wallet); noted as operational oddities, nothing to
  act on.

### Token distribution (verified on-chain snapshot)

Reconstructed directly from the jetton's current holder list rather than
from separately-tracked figures, so it's guaranteed to sum to the verified
total supply exactly. The pool row is a live AMM balance and will drift with
ordinary trading — everything else here is either fixed or moves only via a
deliberate, documented action.

| Category | Tokens | Share |
|---|---|---|
| Burned (zero address) | 57,468,162,303.42 | 82.45% |
| Reward Vault allocation | 9,000,000,000.00 | 12.91% |
| STON.fi pool (TONkAS side, live) | 1,098,521,979.00 | 1.58% |
| Organic buyers (3 wallets) | 1,153,751,573.97 | 1.66% |
| **Founder reserve (discretionary)** | **976,533,839.62** | **1.40%** |
| **Total** | **69,696,969,696** | **100%** |

The Vault allocation and the founder reserve are both currently held in the
same wallet (`UQDZlnNRydIutcTUJFgm6Mggnu79-JIzpr1uoMg9qqW7OE4J`) pending the
Vault transfer at launch; they're split into separate rows here because
they're committed to different purposes, not because they sit in different
places today.
- **The configured `admin` address is not a real multisig — it never was.**
  `EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE`, used as `admin` across
  Registry, Vault, and SkipCollection throughout this build, is **STON.fi's
  shared public router contract** (confirmed on tonscan: tagged `StonFi
  Router`, transaction history shows swaps across dozens of unrelated token
  pairs). It only looked connected because STON.fi's UI routes every user's
  liquidity deposit through it en route to the pair-specific pool. Nobody
  currently holds keys capable of calling `SetPaused`, `SetRouter`,
  `SetSignerKey`, or `ProposeLimits` on anything. Not urgent — nothing is
  deployed to mainnet yet, so this is a placeholder-in-scripts-and-tests
  issue, not live exposure. **Deploying a real multisig and repointing every
  contract's admin field at it is the designated first mainnet action**,
  done before anything else touches mainnet — see "Still blocking" below.

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
- **~57.47B tokens are burned** (sent to the zero address, not held by any
  contract) — the largest plausible source of founder sell-pressure removed
  permanently, arguably a stronger claim than a locked balance since burned
  tokens aren't recoverable through any future exploit of any contract,
  because no contract holds them at all.
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

Originally planned as a strict "testnet first, then touch mainnet liquidity"
sequence. In practice, the DeDust verifiability problem (see "Current mainnet
state" above) forced the liquidity restructuring to happen ahead of that
plan — waiting on full testnet sign-off wasn't compatible with getting off
an unverifiable pool. What's actually happened, in order:

1. ~~Build and fully exercise all four contracts on testnet first~~ — still
   true for Registry/Vault/NFT Collections (built and tested) and Router
   (not yet built), but liquidity restructuring below did not wait on it.
2. **Done:** both DEXs' original liquidity withdrawn.
3. **Done:** re-deposited as a single STON.fi-only position (32 TON +
   1,089,876,600 TONkAS) at the pool's live ratio.
4. **Done:** the ~58.47B tokens that didn't fit the new ratio were split —
   ~57.47B burned, ~1B kept as the founder's discretionary reserve (see
   above).
5. **Done, ongoing:** the founder has since deposited part of the
   discretionary reserve into the STON.fi pool and burned the resulting LP
   tokens too, further deepening locked liquidity and reducing the
   discretionary reserve below its original ~1B figure (see above for exact,
   verified numbers). This is incremental and may recur.
6. **Not yet done:** Router itself — once built, its buyback cycles will
   route to the confirmed STON.fi pool, and resulting LP tokens will route
   to the LP Locker per the original design (that part of the design is
   unchanged).
7. **Not yet done, designated as the first mainnet action once Router is
   ready:** deploy a real multisig and repoint every contract's `admin`
   field at it, replacing the STON.fi-shared-router placeholder — see the
   fake-admin finding above.

---

## Resolved launch parameters

### Registry
- Jetton master: `EQBF6stfWMsDvkEOm2pqKs0C4rU0RRU_fdRDmIgo_sDVpShl` (9 decimals)
- Slot price curve: geometric — `price(n) = 1 TON × 1.15^n`, `MAX_SLOTS = 100`
- Admin: **placeholder** `EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE` — this
  is STON.fi's shared router, not a multisig anyone controls; see "Current
  mainnet state" above. Fine for testnet/dev, must be replaced with a real
  multisig before mainnet deployment.

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
- Oracle signer key: not yet built — ship with placeholder pubkey,
  admin-gated `setOraclePubkey` rotation. **Reused for the NFT referral
  signer too** (see Skip NFT Collections below) — decided directly, not
  derived here: `signerKey` is a per-contract config value already
  structurally independent between Vault and SkipCollection, so splitting
  later is a one-line admin call if it's ever actually warranted, not a
  redeploy. The NFT collection's free-mint rate cap (below) is the real,
  load-bearing fix for that path's exposure; key separation would have been
  a cheap additional layer, not the thing actually protecting it.
- Admin: same placeholder as Registry (not a real multisig — see "Current
  mainnet state" above)

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
- Referral attestation signer: **reuses the Vault's oracle key** — see the
  Vault section above for the reasoning. `SkipCollection` holds its own
  `signerKey` storage slot, structurally independent of the Vault's, so this
  is a config choice, not an architectural coupling.

### Buyback-and-Lock Router
- **Single venue: STON.fi only.** The DeDust leg is dropped, not deferred —
  see "Current mainnet state" above for why. No `DexConfig`-per-venue, no
  50/50 split, no second deposit leg anywhere in the design.
- **STON.fi pool (confirmed on-chain, corrected — see "Current mainnet
  state" above for how the earlier address was caught and fixed):**
  `EQAFGrQk5fPoDK-bhjyW89Z_hnaNOAmlOGtEQW1Y1vK8GDFk` — TONkAS/TON pair,
  interface `stonfi_pool_v2_const_product`, `dex_major_version:2`. This was
  the last blocker; Router is now unblocked to build for real.
- **Full verified address set for Router, v2.2 ConstantProduct:**
  - STON.fi router: `EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE` (v2.2,
    `pool_creation_enabled: true` — same address already known as the
    fake-admin placeholder; two unrelated roles, one legitimate as a DEX
    contract we integrate with, one mistaken as our own `admin`)
  - pTON v2.1 master: `EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S`
  - This router's own pTON wallet:
    `EQACuz151snlY46PKdUOkyiCf0zzcxMsN6XmKQkSKZjkvyFH` — also, confirmed by
    direct on-chain `get_pool_data`, the pool's own `token1_wallet_address`
    (the TON side of the pool's reserve)
  - Pool's TONkAS-side wallet (`token0_wallet_address`):
    `EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt` — the address from
    the earlier mislabeling, now correctly identified as this
- Live pool position at deposit time: 32 TON + 1,089,876,600 TONkAS. Live
  on-chain reserves as of the latest check: 26.060000001 TON /
  1,092,014,534.869648923 TONkAS — drifted via ordinary trading since
  deposit.
- **LP-token policy, settled:** every cycle's resulting LP token routes to
  the Locker, never burned. No fee-claim function exists or is planned —
  decided against in favor of simplicity and zero future admin-trust
  surface on this path. See `docs/architecture.md`'s Router section.
- Cycle threshold: whichever hits first — 10 TON accumulated, or 6 hours elapsed
- Cranker bounty: 1.5% of the batched amount, permissionless
- Quote-signer key: not yet built — placeholder pubkey + rotation, separate
  from the Vault/referral oracle key (this separation stands — unrelated
  decision to the Vault/referral key reuse above; a compromised quote key
  bleeding the buyback and a compromised claim key draining the vault are
  still meant to be independent blast radii)
- Admin: same placeholder as Registry/Vault (not a real multisig — see
  "Current mainnet state" above). Router can be built and tested against
  this placeholder the same way Registry/Vault/SkipCollection already were;
  only *mainnet deployment* needs the real multisig first.

## Resolved: what the earlier flagged concerns turned into

The three items flagged in the previous pass were run through the actual
numbers rather than eyeballed, which changed two of the three conclusions:

1. **Per-claim cap** → not "pick a better constant," a flat cap can't work
   as a backstop at all (see derivation above) — replaced with the
   per-wallet `hoursSinceLastClaim × cappedCeiling` bound.
2. **Multiplier vs. "fixed" budget** → confirmed as a real effect (true floor
   is ~6.5 weeks, not ~3 months) but not a safety issue — the 9B cap holds
   independent of pacing. Timeline note updated above.
3. **Shared oracle key** → reversed twice, net back to shared. First pass:
   "fine to defer" splitting it. Second pass (after finding the referral
   free-mint path had *no* bound at all, not just a looser one than the
   Vault): split into two keys. Final, actual decision: reuse one key after
   all — `signerKey` turned out to be a per-contract config value, not a
   structural coupling, so splitting later is a one-line admin call rather
   than something that needed deciding up front. What did *not* reverse: the
   free-mint path's own on-chain rate cap is required regardless of the key
   question, since that cap — not key separation — is what actually bounds
   the exposure.

## Still blocking

- ~~STON.fi pool's raw contract address~~ — **resolved**:
  `EQAFGrQk5fPoDK-bhjyW89Z_hnaNOAmlOGtEQW1Y1vK8GDFk` (corrected from an
  earlier mislabeled address — see "Current mainnet state" above). Router
  is unblocked to build for real, against the single-venue design.
- A real multisig, deployed and repointed as `admin` across every contract —
  needed before *mainnet deployment* of anything, not before building or
  testing Router (which can use the same placeholder-admin pattern already
  used for Registry/Vault/SkipCollection). Designated as the first mainnet
  action.
- Remaining Vault emission-schedule rows for epochs covering 3B–9B tokens
  mined (or confirmation the halving pattern just continues to 9B)
- Realistic backlog scenario to size the Vault's bucket `capacity` against
- Realistic referral volume to size the NFT collection's free-mint rate cap
  against
