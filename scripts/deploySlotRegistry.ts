import { Address, toNano } from '@ton/core';
import { SlotRegistry } from '../wrappers/SlotRegistry';
import { compile, NetworkProvider } from '@ton/blueprint';

// Resolved parameters — see docs/tokenomics.md "Registry".
// Real multisig, correctly compiled with the pinned func-js version — see
// pinned-hashes.json and the commit that redeployed it after the toolchain-
// mismatch incident. The old address (EQDjHFKV_zZ1fATzlktn1Nqq1bAvSJDns3S-
// FKjlFtTLlEvg) is abandoned; this is the authoritative admin for all
// fresh mainnet deployments.
const ADMIN = Address.parse('EQAHjBAJD8C_kdO3K9Lv7vAnwJttFRS3pxxW5N3yMNY02OcO');

// Router isn't deployed yet (Step 5 in the deploy sequence). Point at the
// admin multisig as a placeholder so forwarded TON has somewhere safe to
// land; call sendSetRouter once the real Router is live.
const ROUTER_PLACEHOLDER = ADMIN;

// price(n) = 1 TON * 1.15^n, n = current extraSlots (0-indexed), MAX_SLOTS = 100.
// 1.15 = 23/20 exactly.
const CURVE = {
    basePrice: toNano('1'),
    num: 23,
    den: 20,
    maxSlots: 100,
};

export async function run(provider: NetworkProvider) {
    const accountCode = await compile('SlotAccount');
    const registryCode = await compile('SlotRegistry');

    const registry = provider.open(
        SlotRegistry.createFromConfig(
            {
                admin: ADMIN,
                router: ROUTER_PLACEHOLDER,
                accountCode,
                curve: CURVE,
                paused: false,
            },
            registryCode
        )
    );

    await registry.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(registry.address);
}
