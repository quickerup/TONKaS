import { Address, toNano } from '@ton/core';
import { Router } from '../wrappers/Router';
import { compile, NetworkProvider } from '@ton/blueprint';

// The LP Locker — real, compiled, already receiving deposits on mainnet. Its deploy data
// is trivial/owner-independent (see LiquidityLocker.tolk), so the same raw address is
// correct on both networks — no network split needed here, unlike the DEX addresses below.
const LOCKER = Address.parse('EQDm9gqYl7hFJSvJLigx-itfoGgZ-4hUwnQ3soNsDmcU6ick');

// Full verified MAINNET STON.fi/pTON address set — see docs/tokenomics.md "Buyback-and-
// Lock Router" for how each of these was independently confirmed (STON.fi's own
// /v1/pools and /v1/routers listings, TonAPI interface fingerprints, and a direct
// on-chain get_pool_data call). Deliberately no setter for any of these in Router.tolk —
// see that file's header comment on why they're immutable rather than admin-mutable.
//
// STONFI_ROUTER is the same address as the mainnet ADMIN placeholder below,
// coincidentally: STON.fi's shared v2.2 ConstantProduct router. Two unrelated roles —
// legitimate here as the actual DEX contract we integrate with, mistaken there as an
// admin placeholder.
const MAINNET_DEX_CONFIG = {
    stonfiRouter: Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE'),
    stonfiTonkasWallet: Address.parse('EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt'),
    ptonWallet: Address.parse('EQACuz151snlY46PKdUOkyiCf0zzcxMsN6XmKQkSKZjkvyFH'),
};

// TESTNET STON.fi/pTON address set — NOT independently verified the way the mainnet set
// above is, and stonfiTonkasWallet/ptonWallet are unresolved placeholders, not real
// addresses. What's actually known, checked directly against testnet via TonClient4
// (testnet-v4.tonhubapi.com) rather than assumed:
//   - stonfiRouter below is the address STON.fi's own SDK repo uses in its test fixtures
//     for the v2.2 CPI testnet router (ston-fi/sdk's CPIRouterV2_2.test.ts /
//     BaseRouterV2_2.test.ts). It IS a live, active testnet account with a real balance
//     and real prior transaction history, and TonAPI tags its code as stonfi_router_v2.
//   - BUT its get-methods (get_router_data, get_router_version) fail with exit code 9
//     ("cell underflow") via three independent paths — testnet.tonapi.io,
//     testnet.toncenter.com, and TonClient4 directly — ruling out a client-side/library-
//     resolution issue specifically (a different testnet router, v1, answered the same
//     query shape cleanly on the same client). This looks like a stale or broken
//     deployment, not a live, integration-ready v2 router, despite matching the expected
//     code hash.
//   - No TONkAS/TON pool exists yet on testnet either way — confirmed via the test
//     jetton's holder list (only the deployer's own wallet and the Vault's jetton wallet
//     show up, no pool-shaped holder).
// Router can still be deployed and tested against this config for everything that
// doesn't require a live DEX round-trip (deposits, ExecuteCycle gating, admin/timelock
// behavior, message construction) — see tests/Router.spec.ts, which already covers all
// of that. Do not attempt a real ExecuteCycle against this config expecting it to
// complete; ptonWallet/stonfiTonkasWallet are ADMIN's own address as an inert stand-in,
// not real DEX wallets, chosen specifically so a real cycle fails loudly (message goes to
// a plain wallet with no swap logic) rather than silently misdirecting funds.
const TESTNET_DEX_CONFIG = {
    stonfiRouter: Address.parse('kQALh-JBBIKK7gr0o4AVf9JZnEsFndqO0qTCyT-D-yBsWk0v'),
    stonfiTonkasWallet: null as Address | null, // unresolved — see comment above
    ptonWallet: null as Address | null, // unresolved — see comment above
};

// Oracle isn't built yet (same status as the Vault/referral signer — see
// docs/tokenomics.md). Deploy paused with a zero quote-signer key so no
// ExecuteCycle can verify against it, then call sendSetQuoteSignerKey once the
// oracle has a real keypair.
const QUOTE_SIGNER_KEY_PLACEHOLDER = 0n;

export async function run(provider: NetworkProvider) {
    const routerCode = await compile('Router');
    const isTestnet = provider.network() === 'testnet';

    // On mainnet, admin is the documented placeholder (STON.fi's shared router — not a
    // real multisig; see docs/tokenomics.md "Current mainnet state") until the real
    // multisig deploy, the designated first mainnet action. On testnet there's no such
    // designated placeholder — use whichever wallet is actually running this script, so
    // whoever deploys can immediately exercise admin functions (SetPaused,
    // SetQuoteSignerKey, ExecuteCycle gating, etc.) without a separate hand-off step.
    const admin = isTestnet ? provider.sender().address! : Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');

    const dexConfig = isTestnet
        ? {
              stonfiRouter: TESTNET_DEX_CONFIG.stonfiRouter,
              stonfiTonkasWallet: TESTNET_DEX_CONFIG.stonfiTonkasWallet ?? admin,
              ptonWallet: TESTNET_DEX_CONFIG.ptonWallet ?? admin,
          }
        : MAINNET_DEX_CONFIG;

    // Same chicken-and-egg as the Vault's jetton wallet: Router's own TONkAS wallet is a
    // function of Router's OWN address, unknowable until after deploy. Placeholder here,
    // then sendSetRewardJettonWallet once the real address is computed.
    const rewardJettonWalletPlaceholder = admin;

    // See docs/tokenomics.md "Buyback-and-Lock Router".
    const MIN_CYCLE_VALUE = toNano('10');
    const MIN_CYCLE_INTERVAL = 21600; // 6h
    const CRANK_BOUNTY_BPS = 150; // 1.5%

    const router = provider.open(
        Router.createFromConfig(
            {
                admin,
                locker: LOCKER,
                stonfiRouter: dexConfig.stonfiRouter,
                stonfiTonkasWallet: dexConfig.stonfiTonkasWallet,
                ptonWallet: dexConfig.ptonWallet,
                quoteSignerKey: QUOTE_SIGNER_KEY_PLACEHOLDER,
                rewardJettonWallet: rewardJettonWalletPlaceholder,
                paused: true, // stays paused until quoteSignerKey + rewardJettonWallet are set for real
                minCycleValue: MIN_CYCLE_VALUE,
                minCycleInterval: MIN_CYCLE_INTERVAL,
                crankBountyBps: CRANK_BOUNTY_BPS,
            },
            routerCode
        )
    );

    await router.sendDeploy(provider.sender(), toNano('0.5'));

    await provider.waitForDeploy(router.address);
}
