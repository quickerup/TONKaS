import { Address, toNano } from '@ton/core';
import { Router } from '../wrappers/Router';
import { compile, NetworkProvider } from '@ton/blueprint';

// Resolved parameters — see docs/tokenomics.md "Buyback-and-Lock Router".
// PLACEHOLDER — this is STON.fi's shared router, not a real multisig. Fine for
// testnet/dev; must be replaced before any mainnet deploy. See docs/tokenomics.md
// "Current mainnet state" — deploying the real multisig is the designated first
// mainnet action.
const ADMIN = Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');

// The LP Locker — real, compiled, already receiving deposits on mainnet. See
// docs/tokenomics.md "Current mainnet state".
const LOCKER = Address.parse('EQDm9gqYl7hFJSvJLigx-itfoGgZ-4hUwnQ3soNsDmcU6ick');

// Full verified STON.fi/pTON address set — see docs/tokenomics.md "Buyback-and-Lock
// Router" for how each of these was independently confirmed (STON.fi's own /v1/pools
// and /v1/routers listings, TonAPI interface fingerprints, and a direct on-chain
// get_pool_data call). Deliberately no setter for any of these in Router.tolk — see
// that file's header comment on why they're immutable rather than admin-mutable.
//
// Same address as ADMIN above, coincidentally: STON.fi's shared v2.2 ConstantProduct
// router. Two unrelated roles — legitimate here as the actual DEX contract we
// integrate with, mistaken above as an admin placeholder.
const STONFI_ROUTER = Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');
const STONFI_TONKAS_WALLET = Address.parse('EQAmkdNztx983XKtHr6DlBPgzYLdHFg-HH1tDUovQRKz0vWt');
const PTON_WALLET = Address.parse('EQACuz151snlY46PKdUOkyiCf0zzcxMsN6XmKQkSKZjkvyFH');

// Oracle isn't built yet (same status as the Vault/referral signer — see
// docs/tokenomics.md). Deploy paused with a zero quote-signer key so no
// ExecuteCycle can verify against it, then call sendSetQuoteSignerKey once the
// oracle has a real keypair.
const QUOTE_SIGNER_KEY_PLACEHOLDER = 0n;

// Same chicken-and-egg as the Vault's jetton wallet: Router's own TONkAS wallet is a
// function of Router's OWN address, unknowable until after deploy. Placeholder here,
// then sendSetRewardJettonWallet once the real address is computed.
const REWARD_JETTON_WALLET_PLACEHOLDER = ADMIN;

// See docs/tokenomics.md "Buyback-and-Lock Router".
const MIN_CYCLE_VALUE = toNano('10');
const MIN_CYCLE_INTERVAL = 21600; // 6h
const CRANK_BOUNTY_BPS = 150; // 1.5%

export async function run(provider: NetworkProvider) {
    const routerCode = await compile('Router');

    const router = provider.open(
        Router.createFromConfig(
            {
                admin: ADMIN,
                locker: LOCKER,
                stonfiRouter: STONFI_ROUTER,
                stonfiTonkasWallet: STONFI_TONKAS_WALLET,
                ptonWallet: PTON_WALLET,
                quoteSignerKey: QUOTE_SIGNER_KEY_PLACEHOLDER,
                rewardJettonWallet: REWARD_JETTON_WALLET_PLACEHOLDER,
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
