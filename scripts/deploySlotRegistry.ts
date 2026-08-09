import { Address, toNano } from '@ton/core';
import { SlotRegistry } from '../wrappers/SlotRegistry';
import { compile, NetworkProvider } from '@ton/blueprint';

// Resolved parameters — see docs/tokenomics.md "Registry".
// PLACEHOLDER — this is STON.fi's shared router, not a real multisig. Fine for
// testnet/dev; must be replaced before any mainnet deploy. See docs/tokenomics.md
// "Current mainnet state" — deploying the real multisig is the designated first
// mainnet action.
const ADMIN = Address.parse('EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE');

// Router isn't deployed yet (blocked on the STON.fi pool address — see
// docs/tokenomics.md "Still blocking"). Point at the admin multisig as a
// placeholder so forwarded TON has somewhere safe to land; call
// sendSetRouter once the real Router is live.
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
