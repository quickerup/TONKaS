<div align="center">

<img src="https://aqua-petite-ostrich-256.mypinata.cloud/ipfs/bafybeifblasnj2uachzac2zw2uh4we3i2asuz5h2fyoy2cz323wstjfzta" alt="TONkAS logo" width="260">

# TONkAS

### A Telegram-Native Mining Game with Permanently Locked Liquidity

**TONkAS Protocol Contributors**
Draft whitepaper — August 8, 2026

</div>

<sub>Logo above is served from the token's on-chain IPFS metadata (primary source, kept in sync with the jetton). A local mirror is kept at [`docs/assets/tonkas-logo.gif`](assets/tonkas-logo.gif) as a fallback reference in case the gateway is unavailable — as it was, transiently, on the day this file was written.</sub>

---

**Document status.** The LP Locker, Slot Registry, and Reward Vault described in this paper are built and tested. The Buyback-and-Lock Router and Skip NFT Collections are in development. The system is not fully deployed on mainnet. Contract addresses, the oracle public key, and administrative addresses will be published at launch and are intentionally not represented here as live credentials.

> *The mascot is a frog. The security claims are not a joke.*

---

## Contents

1. [Abstract](#1-abstract)
2. [The Problem: "Trust Us" Is Not a Security Model](#2-the-problem-trust-us-is-not-a-security-model)
3. [Design Principles](#3-design-principles)
4. [System Overview](#4-system-overview)
5. [Contract Architecture](#5-contract-architecture)
   - 5.1 [LP Locker](#51-lp-locker)
   - 5.2 [Slot Registry](#52-slot-registry)
   - 5.3 [Reward Vault](#53-reward-vault)
   - 5.4 [Skip NFT Collections](#54-skip-nft-collections)
   - 5.5 [Buyback-and-Lock Router](#55-buyback-and-lock-router)
6. [The Mining Loop](#6-the-mining-loop)
   - 6.1 [Player Experience](#61-player-experience)
   - 6.2 [What a Player Is Buying](#62-what-a-player-is-buying)
7. [Tokenomics](#7-tokenomics)
   - 7.1 [Fixed Mining Allocation](#71-fixed-mining-allocation)
   - 7.2 [Emission Schedule](#72-emission-schedule)
   - 7.3 [Purchase Flow](#73-purchase-flow)
8. [Security Model](#8-security-model)
   - 8.1 [Trust-Minimized Guarantees](#81-trust-minimized-guarantees)
   - 8.2 [Remaining Trust and Risk](#82-remaining-trust-and-risk)
   - 8.3 [Launch Verification Checklist](#83-launch-verification-checklist)
9. [Development Status and Roadmap](#9-development-status-and-roadmap)
10. [Conclusion](#10-conclusion)
11. [Disclaimers](#11-disclaimers)

---

## 1. Abstract

TONkAS is a Telegram-native mining game on The Open Network (TON) built around a frog meme token. A player activates mining through a Telegram bot, earns a share of a fixed hourly network reward, and may purchase additional mining slots or passes that reduce the frequency of required interaction.

That description places the project in a familiar category. The category has also produced a familiar set of failures: points that never become assets, token launches whose liquidity remains under team control, and games in which player spending creates revenue for an operator without creating durable support for the token. A frog does not solve those problems. Contract architecture can.

The central property of TONkAS is **permanent liquidity custody**. The LP Locker has no withdrawal function, no administrative escape hatch, and no upgrade path. Original liquidity and all liquidity created from future in-game purchases are sent to this contract. Because the contract contains no code path capable of transferring those assets back out, the lock is not a promise about future conduct or a timer that eventually expires. It is the structural absence of an exit.

Mining rewards are drawn from a fixed allocation of 9,000,000,000 tokens, with no future minting. Emissions halve after each 1,000,000,000 tokens distributed. Off-chain computation makes hourly participation practical inside Telegram, while the Reward Vault independently bounds signed claims according to elapsed time and the applicable emission rate. The result is deliberately simple: a meme-native game whose material economic claims are intended to be verified in code.

## 2. The Problem: "Trust Us" Is Not a Security Model

Tap-to-earn and Telegram mining projects commonly ask players to accept one or more unverified propositions:

- that off-chain points will later convert into a token on favorable terms;
- that a token will receive meaningful and lasting liquidity;
- that insiders will not withdraw that liquidity;
- that reward issuance will remain within the advertised supply; and
- that spending inside the game will strengthen, rather than merely monetize, the player economy.

The weakness is not that every team making these statements is dishonest. The weakness is that honesty is doing work that software should do. A conventional liquidity lock can expire. An administrator can revoke a lock if the contract permits it. An upgradeable contract can acquire a withdrawal path later. In each case, the user ultimately depends on somebody choosing not to use an available exit.

TONkAS takes a narrower and more testable position. The anti-rug claim is not "the team will never withdraw locked liquidity." It is "the Locker cannot send locked assets out because no such instruction exists." Purchases of slots and skip passes are routed back into market liquidity, and the resulting LP tokens are delivered to the same non-withdrawable Locker. Participation therefore deepens the locked position rather than opening another place from which value can be removed.

This does not eliminate market risk, contract risk, oracle risk, or the possibility that a meme token becomes unpopular. It does eliminate one specific and historically important power: the ability of a privileged party to reclaim LP tokens held by the Locker. That distinction is the point of the protocol.

## 3. Design Principles

The system is organized around five rules.

1. **Security properties must be inspectable.** Critical restrictions are implemented by contract logic, not by a published intention.
2. **Player spending must return to the market structure.** TON received for protocol purchases is converted into permanently locked liquidity.
3. **Convenience must not buy a higher emission rate.** Skip tiers change how often a player must interact; they do not change the reward earned by an active slot.
4. **Issuance must be finite.** The mining allocation is fixed, and the Vault cannot mint additional rewards.
5. **The interface should be native to the community.** The game lives in Telegram. There is no separate dashboard pretending the frog needs enterprise software.

## 4. System Overview

The protocol separates custody, slot ownership, reward distribution, convenience rights, and purchase routing into distinct components. This reduces the authority of each component and makes the principal economic flows easier to audit.

**Table 1: Protocol components and status as of this draft.**

| Component | Responsibility | Status |
|---|---|---|
| LP Locker | Irreversible custody of TON, jettons, and LP tokens | Built and tested |
| Slot Registry | One implicit free slot per wallet; paid slot ownership and pricing | Built and tested |
| Reward Vault | Custody and bounded distribution of the 9 billion token reward allocation | Built and tested |
| Skip NFT Collections | 24-hour and permanent interaction-skip rights | In development |
| Buyback-and-Lock Router | Converts purchase proceeds into STON.fi liquidity and sends LP tokens to the Locker | In development |
| Telegram bot and oracle | Player interface, hourly participation accounting, and signed claim attestations | Integration in progress |

Mainnet identifiers will be listed in the final deployment record:

- LP Locker: `[contract address on mainnet launch]`
- Slot Registry: `[contract address on mainnet launch]`
- Reward Vault: `[contract address on mainnet launch]`
- Skip NFT Collections: `[collection addresses on mainnet launch]`
- Buyback-and-Lock Router: `[contract address on mainnet launch]`
- Oracle public key: `[public key on mainnet launch]`

**No placeholder in this paper should be interpreted as a deployed address or key.**

## 5. Contract Architecture

### 5.1 LP Locker

The LP Locker is the terminal custody contract for the protocol's locked assets. It accepts arbitrary jettons and TON. Its intended holdings include the LP tokens representing the project's original liquidity and the LP tokens created by the Buyback-and-Lock Router.

The Locker has:

- no function that transfers TON, jettons, or LP tokens out;
- no owner withdrawal;
- no administrator withdrawal;
- no emergency withdrawal;
- no time-based release; and
- no contract upgrade path through which a release function could later be introduced.

Accordingly, this is not a time lock and it is not an administrator-revocable lock. Assets correctly delivered to the Locker remain there permanently. The guarantee is intentionally blunt: the contract can receive, but it cannot return.

This property applies to assets in the Locker itself. It does not imply that a DEX pool cannot experience price movement, impermanent loss, pool-contract failure, or changes in the relative value of its reserves. It means that the LP position held by the Locker cannot be redeemed by the team or another privileged party.

### 5.2 Slot Registry

The Slot Registry records mining capacity by wallet. Every wallet is treated as owning one slot without registration or prior interaction. A read against an unseen wallet therefore returns one slot, not zero.

Additional slots are purchased on-chain. Let *n* be the number of additional slots already purchased by a wallet, beginning at *n* = 0. The price of the next additional slot is

> **P(n) = 1 TON × 1.15ⁿ**  — (Eq. 1)

The first paid slot therefore costs 1 TON, the second costs 1.15 TON, and each subsequent paid slot costs 15% more than the preceding one, subject to the contract's integer rounding rules. A wallet may hold no more than 100 slots in total, including its implicit free slot. The cap limits the mining capacity attributable to a single wallet address; it is not presented as proof that one person cannot control multiple wallets.

Slot purchases are designed to forward purchase value to the Buyback-and-Lock Router. They do not create a withdrawal claim against the Registry and do not grant a higher reward rate per slot. They increase only the number of equally weighted slots controlled by the wallet.

### 5.3 Reward Vault

The Reward Vault holds 9,000,000,000 TONkAS reward tokens. This balance is the full supply-side promise of the mining game. The Vault has no mint authority, and the protocol defines no future mining issuance beyond this allocation.

The baseline network-wide hourly reward begins at approximately 456,621 tokens. Emission epochs are determined by cumulative tokens distributed, not by block height, calendar time, or an assumed number of claims. If *M* denotes cumulative rewards distributed by the Vault, the epoch is

> **e(M) = ⌊ M / 1,000,000,000 ⌋**  — (Eq. 2)

and the baseline hourly budget in that epoch is

> **R_e ≈ 456,621 / 2ᵉ  tokens per hour** (approximately, at *e* = 0)  — (Eq. 3)

Each time cumulative distribution crosses another 1,000,000,000-token boundary, the rate halves. Accounting at an epoch boundary is piecewise: time and distribution before the boundary are bounded at the prior rate, and amounts after it are bounded at the new rate. No scheduling assumption can move a halving past its cumulative-distribution threshold.

For hour *h*, let *A_h* be the number of active slots and let *b_h* be the unique-participation multiplier. The multiplier increases modestly with higher unique participation and is constrained by

> **1 ≤ b_h ≤ 2**  — (Eq. 4)

The enforceable consequence is that no hour may distribute more than twice its applicable baseline budget. When *A_h* > 0, each active slot receives the same hourly amount:

> **r_h = (b_h × R_e(h)) / A_h**  — (Eq. 5)

The exact participation-bonus curve will be included in the final protocol parameter schedule before mainnet launch. This paper does not invent an unstated curve; it records the consensus-relevant bounds: the bonus depends on unique participation, and the total hourly budget cannot exceed 2R_e.

Rewards accrue off-chain until claimed. The oracle signs an attestation containing the claim data required by the Vault, including the claimant, amount, and replay-protection fields. The Vault verifies the signature but does not treat it as unlimited authority. It independently computes the maximum amount the wallet could have accrued from elapsed time and the applicable epoch rates and rejects a claim above that ceiling. Already claimed amounts and claim identifiers are tracked so that a valid attestation cannot be paid twice.

This division of responsibility has two purposes. The oracle can account for Telegram activity and the active-slot set without placing every hourly button press on-chain. The Vault still constrains value outflow. Compromise of the signing key could falsify participation within the contract's permitted envelope, but it cannot authorize instantaneous withdrawal of the Vault or payment beyond the mathematical time-and-rate ceiling.

### 5.4 Skip NFT Collections

The default mining tier requires one interaction per hour. Two NFT-based tiers change that interaction requirement:

**Table 2: Interaction tiers. All active slots earn under the same per-slot formula.**

| Tier | Acquisition | Effect |
|---|---|---|
| Default | Free | A slot is active for an hour when the player presses the mining button during that hour. |
| 24-hour skip | 5 TON, or earned by referring five friends who each register and participate at least once | The holder's slots remain active for the pass's 24-hour validity period without hourly presses. Reactivating is repeatable: the holder can refresh the window at any time while they hold the pass, not just once. |
| Forever pass | 10 TON | The holder's slots remain active without further interaction while the wallet holds the NFT. |

The 24-hour referral route creates an eligibility condition, not a higher reward class. Each of the five referred wallets must register and participate at least once before the free pass can be earned.

The Forever pass is a transferable NFT. Its mining convenience follows current ownership: it may be sold or gifted, and a prior owner loses Forever status after transferring it unless that wallet holds another qualifying pass. Neither paid tier increases the reward weight of a slot. A slot that is active through a button press, a 24-hour pass, or a Forever pass is counted identically.

Both Skip NFT Collections are in development. Their final collection addresses and implementation details will be published only after testing and deployment.

### 5.5 Buyback-and-Lock Router

The Buyback-and-Lock Router is the purchase-settlement path for paid slots and NFTs. For TON received through those purchases, the Router is designed to:

1. swap one half of the received TON for the TONkAS reward token through the token's STON.fi pool;
2. pair the acquired tokens with the remaining TON;
3. provide the resulting liquidity to that same STON.fi pool; and
4. send all resulting LP tokens directly to the LP Locker.

The protocol's liquidity strategy is single-venue by design, not as an interim state pending a second integration. An earlier design routed liquidity across two DEXes; that was superseded after one candidate venue's pool architecture proved unverifiable through standard on-chain tooling in ways the protocol should not have to depend on. TONkAS liquidity lives on STON.fi.

Execution amounts will necessarily reflect DEX fees, price impact, reserve ratios, minimum-output checks, and integer rounding. Those operational effects do not change the custody destination: LP tokens produced by successful routing are sent to the non-withdrawable Locker, and are never burned. Neither the Router nor the Locker has, or is planned to have, a function that claims trading fees accrued by a locked LP position — that surface was deliberately left out in favor of simplicity and a smaller admin-trust footprint. Accrued fees stay inside the position and compound it.

The Router is being built last so that its integration targets the actual DEX interface and pool behavior rather than an early scaffold. It is not complete as of this draft. Until its source, tests, configured pool, and deployed address are published, no reader should treat the purchase-routing mechanism as live.

## 6. The Mining Loop

### 6.1 Player Experience

Participation occurs inside a Telegram bot. A minimal landing page directs users to the bot; it is not a second application and does not hold a separate mining state.

The bot's pinned message presents a mining rig. When mining is inactive, the rig is static. When the player activates mining, the display animates with spinning fans and scrolling hash values. The animation is interface feedback, not proof-of-work and not a claim that the user's device is performing useful computation. No phone is being asked to solve hashes for the protocol. The "mining" is the game's distribution mechanic.

Each protocol hour is treated as a block. A wallet's slots are active for that hour if at least one of the following is true:

- the player presses the mining button during the hour;
- the wallet holds an active 24-hour skip pass; or
- the wallet holds a Forever pass.

The applicable network reward budget is divided evenly among all active slots. A wallet with *s* active slots earns *s·r_h* for hour *h*. Rewards accumulate in the oracle's accounting state and are transferred only when the player submits an on-chain claim accepted by the Reward Vault. Claims are on demand; there is no automatic hourly transaction.

### 6.2 What a Player Is Buying

A paid slot buys one additional unit of equally weighted mining capacity, subject to the 100-slot wallet cap. A skip NFT buys reduced interaction frequency. Neither product promises a fixed token return, a fiat-denominated return, or a profit. Per-slot rewards vary with the emission epoch, the participation multiplier, and the number of active slots in the hour.

Purchase TON is not intended as protocol revenue. After the Router is deployed and activated, it is routed into the token's STON.fi liquidity, whose LP tokens are locked permanently. This makes game participation part of the protocol's liquidity formation. It does not guarantee price appreciation or sufficient trading volume.

## 7. Tokenomics

### 7.1 Fixed Mining Allocation

The Reward Vault allocation is exactly 9,000,000,000 tokens. No further tokens can be minted for mining. The allocation is released only through valid claims within the Vault's emission constraints.

This paper does not specify allocations outside the mining Vault, initial DEX seeding quantities, pool ratios, or any other launch distribution not provided in the final token deployment record. Those values must be published before launch and reconciled against the deployed jetton supply. The absence of those values here is deliberate; a whitepaper should not turn an undecided number into a fact by typesetting it.

### 7.2 Emission Schedule

The emission schedule has the following fixed properties:

- initial baseline network budget: approximately 456,621 tokens per hour;
- halving interval: every 1,000,000,000 cumulative tokens distributed;
- halving basis: distributed supply, not elapsed time;
- hourly participation multiplier: at least 1 and at most 2;
- allocation ceiling: 9,000,000,000 tokens; and
- slot weighting: equal for every active slot, regardless of activation tier.

The schedule slows distribution as cumulative mining advances. Because the trigger is actual distribution, periods with little or no participation do not consume an epoch merely because time passes. Conversely, increased participation can raise an hour's total budget only within the 2R_e cap and cannot bypass the next cumulative halving threshold.

### 7.3 Purchase Flow

Once the Router is deployed, paid interactions create the following economic path:

> **slot or NFT purchase → token purchase and STON.fi liquidity provision → LP Locker**  — (Eq. 6)

There is no later step from the LP Locker back to the team. That missing arrow is the core tokenomic constraint.

## 8. Security Model

### 8.1 Trust-Minimized Guarantees

The following properties are intended to be directly verifiable in deployed code and state:

- assets held by the LP Locker have no contract-mediated exit;
- the Locker cannot be upgraded to add an exit;
- no function exists, in the Router or the Locker, to claim trading fees accrued by a locked LP position — accrued fees remain inside the position and compound it, so locked value grows from principal and trading activity together, not principal alone;
- approximately 57.47 billion TONkAS tokens have been sent to the TON network's zero address and are unspendable by any party, verifiable directly against the jetton's on-chain holder records;
- the Registry gives each wallet one implicit slot and caps total slots at 100;
- paid-slot prices follow the geometric formula enforced by the Registry;
- the Reward Vault cannot mint additional reward tokens;
- the Vault cannot distribute more than its funded balance;
- claim authorization requires a valid oracle attestation;
- claim amounts are independently limited by elapsed time and emission rate; and
- replayed or already-paid claims are rejected.

These statements must be checked against the mainnet bytecode and configuration at launch. Source code alone is not proof that a particular deployed address contains that code.

The burn figure above is not a target or a future commitment; it is a completed transaction, checkable today against the deployed jetton's holder list independent of anything this paper claims. It functions as a second, distinct anti-rug guarantee alongside locked LP: locked LP removes the trading pool itself as a source of extractable value, while the burn permanently removes the largest plausible source of founder sell-pressure from the circulating supply. Tokens sent to the zero address are not held by any contract and cannot be recovered by any future code path, upgrade, or exploit, because there is no contract in the recovery loop at all.

### 8.2 Remaining Trust and Risk

Permanent LP custody solves a specific problem, not every problem. Users remain exposed to the following categories.

**Oracle availability and correctness.** The oracle determines participation and prepares claim attestations. A failed oracle can delay claims. A compromised oracle can misreport activity up to the Vault's on-chain ceiling. Key rotation and failure procedures will be documented with the final deployment configuration.

**Smart-contract defects.** A non-upgradeable Locker prevents an administrator from adding a withdrawal path, but non-upgradeability also prevents patching that contract. Bugs in the Locker, Registry, Vault, NFT collections, Router, jetton contracts, DEX contracts, or their message integrations can cause loss or unavailability.

**DEX and routing risk.** Swaps and liquidity deposits are subject to slippage, front-running or adverse ordering, pool imbalance, DEX fees, and defects in external contracts. Minimum-output and message-validation rules reduce some risks but cannot remove market execution risk.

**Wallet multiplicity.** The 100-slot limit is per wallet. Public blockchains do not provide a reliable one-human-one-wallet identity layer, so the cap does not prevent a person or coordinated group from using multiple wallets.

**Referral abuse.** Requiring referred wallets to register and participate once raises the cost of trivial referrals but does not prove that five distinct humans are involved. The referral reward should be understood under that limitation.

**Market risk.** Locked liquidity can still be shallow relative to order size, and a token can lose most or all of its market value. A permanent LP position does not establish a price floor, guarantee a buyer, or make the token an investment with an assured return.

**Interface risk.** Telegram accounts, bots, DNS records, landing pages, and wallets can be impersonated or compromised. Users must verify the published bot identity and mainnet addresses rather than relying on forwarded messages or visual branding.

### 8.3 Launch Verification Checklist

Before interacting with the production system, a user or independent reviewer should be able to verify:

1. the official mainnet address of every contract and NFT collection;
2. that the Locker bytecode contains no outbound asset path and no upgrade mechanism;
3. that initial and Router-created LP tokens are actually held by the published Locker;
4. the Reward Vault's token balance, jetton identity, emission parameters, and oracle key;
5. the Registry's price curve and 100-slot cap;
6. the Router's approved DEX pools, slippage constraints, and LP-token destination;
7. the NFT ownership checks and transfer behavior; and
8. the correspondence between published source, build artifacts, and deployed bytecode.

## 9. Development Status and Roadmap

The current implementation status is factual: the LP Locker, Slot Registry, and Reward Vault are built and tested; the Buyback-and-Lock Router and Skip NFT Collections remain in development. Full mainnet deployment has not occurred.

> **Roadmap placeholder.** Milestones, sequencing, audit steps, testnet release criteria, and mainnet launch criteria will be inserted here when approved. No calendar dates are committed in this draft.

The Router will be completed against the actual DEX integration. The final whitepaper and deployment record must not mark it or the Skip NFT Collections as complete until their code, tests, and production configuration support that statement.

## 10. Conclusion

TONkAS is not an attempt to disguise a meme coin as institutional finance. It is a frog-token mining game designed for Telegram, with animated mining rigs, referral mechanics, purchasable convenience, and all the social unpredictability that description implies.

Its engineering claim is separate and exact. Liquidity delivered to the LP Locker cannot be withdrawn because the Locker has no withdrawal function and no upgrade path. The mining allocation is finite. Emission is bounded. Signed claims are constrained on-chain. Purchases are designed to become additional locked liquidity rather than a new discretionary treasury flow.

The project can therefore be judged on two different axes without confusing them. The frog may or may not become culturally important. The contracts must still do precisely what they say.

## 11. Disclaimers

This document is a technical description of a system under development. It is not an offer to sell securities, investment advice, legal advice, tax advice, or a promise of profit. Token prices and mining rewards may be volatile, illiquid, or worthless. Participation may be restricted by law in some jurisdictions, and each participant is responsible for determining whether use is lawful where they reside.

Mechanisms described as in development are not available guarantees. Placeholder addresses and keys are not live credentials. Only final deployed bytecode, contract state, published configuration, and verified asset flows can establish the behavior of the production system.

Permanent locking is irreversible by design. Assets mistakenly sent to the Locker cannot be recovered. Users should understand this consequence as clearly as they understand its anti-rug benefit.

No audit, test suite, or formal review can prove the absence of all defects. Users should review the final contracts, independent security materials, and launch disclosures before committing funds.

Nothing in this paper guarantees continued operation of Telegram, TON, any DEX, the oracle service, the bot interface, or third-party wallet software.
