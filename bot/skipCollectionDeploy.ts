import { Address, beginCell, Cell, storeStateInit, toNano } from '@ton/core';
import { SendTransactionRequest } from '@tonconnect/sdk';
import { SkipCollection, SkipCollectionConfig, offchainContent, TIER_24H_SKIP, TIER_FOREVER } from '../wrappers/SkipCollection';
import { ORACLE_SIGNER_KEY } from './vaultDeploy';

// ------------------------------------------------------------------
// Decided parameters (see docs/tokenomics.md)
// ------------------------------------------------------------------

// 2000 free referral mints per day, encoded as a uint16 capacity in the contract.
// The on-chain bucket replenishes at 2000 tokens per 86400 seconds (1 day).
// freeMintBucketCapacity is stored as a uint16 — max 65535 — so 2000 fits fine.
export const FREE_MINT_BUCKET_CAPACITY = 2000;

// Mint prices per tokenomics.md
export const MINT_PRICE_24H   = toNano('5');   // 5 TON
export const MINT_PRICE_FOREVER = toNano('10'); // 10 TON

// IPFS content URIs provided by the user
export const COLLECTION_CONTENT_URI = 'https://violet-accused-scorpion-1.mypinata.cloud/ipfs/bafybeib7ny3xb5t5rrbfiqwgs3qwdaau6hghjnstzf3mbwlzgbyo7jxwsa';
export const FOREVER_CONTENT_URI    = 'https://rose-binding-parrotfish-744.mypinata.cloud/ipfs/bafybeidgn7da2cnvhgwiurcbjpfcatr6sghtqgwdiwgdrufpgrddulcxki';

// A single shared SkipCollection handles both tiers via the `tier` byte in PaidMint.
// The collection's `content24h` field is the 24h-skip art and `contentForever` is the forever art.
export function buildSkipCollectionConfig(
    admin: Address,
    router: Address,
    itemCode: Cell,
    referralAccountCode: Cell,
): SkipCollectionConfig {
    return {
        admin,
        router,
        signerKey: ORACLE_SIGNER_KEY,
        itemCode,
        referralAccountCode,
        // collectionContent: a minimal off-chain cell pointing at the 24h art (used as the
        // TEP-64 collection-level metadata URI by wallets/marketplaces).
        collectionContent: offchainContent(COLLECTION_CONTENT_URI),
        content24h: offchainContent(COLLECTION_CONTENT_URI),
        contentForever: offchainContent(FOREVER_CONTENT_URI),
        paused: false, // starts unpaused — no jetton involved, no reason to gate
        freeMintBucketCapacity: FREE_MINT_BUCKET_CAPACITY,
    };
}

export function computeSkipCollectionAddress(
    admin: Address,
    router: Address,
    collectionCode: Cell,
    itemCode: Cell,
    referralAccountCode: Cell,
): { collection: SkipCollection; address: Address } {
    const config = buildSkipCollectionConfig(admin, router, itemCode, referralAccountCode);
    const collection = SkipCollection.createFromConfig(config, collectionCode);
    return { collection, address: collection.address };
}

export function buildSkipCollectionDeployRequest(
    collection: SkipCollection,
    fromAddress: Address,
): SendTransactionRequest {
    if (!collection.init) throw new Error('collection.init is missing');
    const stateInit = beginCell().store(storeStateInit(collection.init)).endCell();
    return {
        validUntil: Math.floor(Date.now() / 1000) + 280,
        from: fromAddress.toRawString(),
        messages: [
            {
                address: collection.address.toString(),
                amount: toNano('0.05').toString(),
                stateInit: stateInit.toBoc().toString('base64'),
                payload: beginCell().endCell().toBoc().toString('base64'),
            },
        ],
    };
}
