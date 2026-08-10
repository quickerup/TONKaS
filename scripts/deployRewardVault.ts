import { Address, toNano } from '@ton/core';
import { RewardVault } from '../wrappers/RewardVault';
import { compile, NetworkProvider } from '@ton/blueprint';

// Resolved parameters — see docs/tokenomics.md "Vault".
// Real multisig, correctly compiled with the pinned func-js version — see
// pinned-hashes.json and the commit that redeployed it after the toolchain-
// mismatch incident. The old address (EQDjHFKV_zZ1fATzlktn1Nqq1bAvSJDns3S-
// FKjlFtTLlEvg) is abandoned; this is the authoritative admin for all
// fresh mainnet deployments.
const ADMIN = Address.parse('EQAHjBAJD8C_kdO3K9Lv7vAnwJttFRS3pxxW5N3yMNY02OcO');
const DECIMALS = 1000000000n; // reward jetton has 9 decimals

// Real oracle public key from Step 0 — see https://tonkas-oracle.duck47783.workers.dev/pubkey
// and the commit that deployed worker/. The zero-placeholder approach used here originally
// (before Step 0 was complete) is superseded; bot/vaultDeploy.ts has always used the real
// key and is the actual mainnet deploy path.
const SIGNER_KEY = BigInt('0x1ec527f9a4e266724a26d318f86804edb8451c2299627768a5aafd600aebe9e4');

// The Vault's jetton wallet address is a function of the Vault's OWN address
// (deployed after this config is fixed), so it can't be known up front —
// classic chicken/egg. Deploy with a placeholder, then once the Vault address
// is known, compute the real jetton wallet via the jetton master's
// get_wallet_address and call sendSetJettonWallet before unpausing.
const JETTON_WALLET_PLACEHOLDER = ADMIN;

// 1B tokens per halving epoch, base rate ~456,621 tokens/hour at epoch 0 —
// see docs/tokenomics.md's emission schedule table. Only 3 of 9 epochs were
// given explicitly; the contract computes every epoch as baseRate >> epoch,
// so the rest follow automatically from this one value.
const HALVING_INTERVAL = 1_000_000_000n * DECIMALS;
const BASE_RATE = 456621n * DECIMALS; // tokens/hour, epoch 0

// Secondary flat ceiling only — the primary bound is the per-wallet
// hoursSinceLastClaim * cappedCeiling formula computed on-chain. See
// docs/tokenomics.md point 1 for why a flat number can't be the primary
// defense; this is carried over from the original ask as a loose backstop.
const MAX_PER_CLAIM = 10_000_000n * DECIMALS;

// PROVISIONAL — docs/tokenomics.md flags bucket capacity as an open product
// decision (needs a real worst-case backlog scenario, not a guess). Sized
// here at 14 days of the epoch-0 UNCAPPED steady rate as a placeholder:
// 456,621/hr * 24 * 14 ≈ 153.4M tokens, rounded down to 150M. Revisit before
// mainnet — this number was picked to unblock testnet, not a final answer.
const BUCKET_CAPACITY = 150_000_000n * DECIMALS;

export async function run(provider: NetworkProvider) {
    const claimAccountCode = await compile('ClaimAccount');
    const vaultCode = await compile('RewardVault');

    const vault = provider.open(
        RewardVault.createFromConfig(
            {
                admin: ADMIN,
                signerKey: SIGNER_KEY,
                jettonWallet: JETTON_WALLET_PLACEHOLDER,
                claimAccountCode,
                halvingInterval: HALVING_INTERVAL,
                baseRate: BASE_RATE,
                maxPerClaim: MAX_PER_CLAIM,
                bucketCapacity: BUCKET_CAPACITY,
                paused: true, // stays paused until signerKey + jettonWallet are set for real
            },
            vaultCode
        )
    );

    await vault.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(vault.address);
}
