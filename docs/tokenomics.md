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
  live ratio: **32 TON + 1,089,876,600 TONkAS**.
- **STON.fi pool address (confirmed on-chain):**
  `EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt`. Found via the jetton's
  holder list — the pool's reserve is held directly at this address; its
  recorded TEP-74 `owner` field is STON.fi's shared router (see the fake-admin
  finding below — same address, different role here: an administrative field
  on the pool's wallet record, not evidence of who holds the tokens).
- Of the ~58.47B tokens that didn't fit into the single-pool deposit ratio:
  - **~57,468,162,303.42 tokens (~57.47B) were burned** — sent to the TON
    zero/null address, confirmed on-chain. This was a deliberate operational
    call: burning achieves permanent removal from circulating supply without
    spending mainnet gas deploying and routing through the LP Locker contract
    for a plain (non-LP) balance that has no reason to ever move again. This
    is documented as a **second anti-rug pillar** alongside the locked LP
    position — see "Anti-rug guarantees" below.
  - **~1B tokens were kept as a founder reserve**, intended for operational
    uses (e.g. paying a future dev team), not burned and not part of any
    anti-rug claim.
- A further **10B tokens held directly** (not in a pool) in dev wallet
  `UQDZlnNRydIutcTUJFgm6Mggnu79-JIzpr1uoMg9qqW7OE4J` (confirmed active), of
  which **9B is earmarked for the game's Reward Vault**, transferred in at
  launch. Unrelated to the burn/founder-reserve split above — this is a
  separate, earlier-documented holding.
- A handful of buys have already happened directly against the pool, outside
  the game — expected and fine, the game isn't the only entry point. Two
  such organic-buyer wallets are visible in the jetton's holder list; noted
  as operational oddities, nothing to act on.
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
   ~57.47B burned, ~1B kept as a founder reserve (see above).
5. **Not yet done:** Router itself — once built, its buyback cycles will
   route to the confirmed STON.fi pool, and resulting LP tokens will route
   to the LP Locker per the original design (that part of the design is
   unchanged).
6. **Not yet done, designated as the first mainnet action once Router is
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
- **STON.fi pool (confirmed on-chain):**
  `EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt` — TONkAS/TON pair,
  found via the jetton's holder list (the pool holds its reserve directly at
  this address). This was the last blocker; Router is now unblocked to build
  for real.
- Live pool position: 32 TON + 1,089,876,600 TONkAS, deposited at the pool's
  live ratio.
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
  `EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt`. Router is unblocked to
  build for real, against the single-venue design.
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
