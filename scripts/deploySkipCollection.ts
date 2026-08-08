import { Address, toNano } from '@ton/core';
import { SkipCollection, offchainContent } from '../wrappers/SkipCollection';
import { compile, NetworkProvider } from '@ton/blueprint';

// Resolved parameters — see docs/tokenomics.md "Skip NFT Collections".
const ADMIN = Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');

// Router isn't deployed yet — same placeholder pattern as Registry/Vault.
const ROUTER_PLACEHOLDER = ADMIN;

// Oracle isn't built yet — deploy paused with a zero signer key, same pattern as Vault.
const SIGNER_KEY_PLACEHOLDER = 0n;

// Starting values per docs/tokenomics.md — conservative, timelocked to raise.
const FREE_MINT_BUCKET_CAPACITY = 10;

export async function run(provider: NetworkProvider) {
    const itemCode = await compile('SkipItem');
    const referralAccountCode = await compile('ReferralAccount');
    const collectionCode = await compile('SkipCollection');

    const collection = provider.open(
        SkipCollection.createFromConfig(
            {
                admin: ADMIN,
                router: ROUTER_PLACEHOLDER,
                signerKey: SIGNER_KEY_PLACEHOLDER,
                itemCode,
                referralAccountCode,
                collectionContent: offchainContent('https://placeholder.tonkas.example/collection.json'),
                content24h: offchainContent('https://placeholder.tonkas.example/skip-24h.json'),
                contentForever: offchainContent('https://placeholder.tonkas.example/skip-forever.json'),
                paused: true, // stays paused until signerKey + router are set for real
                freeMintBucketCapacity: FREE_MINT_BUCKET_CAPACITY,
            },
            collectionCode
        )
    );

    await collection.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(collection.address);
}
