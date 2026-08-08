import { Address, toNano } from '@ton/core';
import { RewardVault } from '../wrappers/RewardVault';
import { compile, NetworkProvider } from '@ton/blueprint';

// Resolved parameters — see docs/tokenomics.md "Vault".
const ADMIN = Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');
const DECIMALS = 1000000000n; // reward jetton has 9 decimals

// Oracle isn't built yet (see docs/tokenomics.md "Oracle signer key: not yet
// built"). Deploy paused with a zero signer key so no claim can verify against
// it, then call sendSetSignerKey once the oracle has a real keypair.
const SIGNER_KEY_PLACEHOLDER = 0n;

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
                signerKey: SIGNER_KEY_PLACEHOLDER,
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
