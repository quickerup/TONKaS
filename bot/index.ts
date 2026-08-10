import 'dotenv/config';
import * as fs from 'fs';
import { Bot, InlineKeyboard } from 'grammy';
import { Address, Cell } from '@ton/core';
import { TonClient4 } from '@ton/ton';
import { createConnector, getConnectLink, getReopenWalletLink, requestTransaction, waitForConnection } from './tonConnect';
import { buildMultisigConfig, computeMultisigAddress, buildDeployRequest } from './multisigDeploy';
import { Multisig } from '../wrappers/Multisig';
import { registerDeployCallbacks, startDeployFlow, DeployDescriptor } from './deployFlow';
import { computeLockerAddress, buildLockerDeployRequest } from './lockerDeploy';
import { LiquidityLocker } from '../wrappers/LiquidityLocker';
import { computeRegistryAddress, buildRegistryDeployRequest, CURVE } from './registryDeploy';
import { SlotRegistry } from '../wrappers/SlotRegistry';
import { computeVaultAddress, buildVaultDeployRequest, ORACLE_SIGNER_KEY, HALVING_INTERVAL, BASE_RATE, MAX_PER_CLAIM, BUCKET_CAPACITY } from './vaultDeploy';
import { RewardVault, OP_SET_JETTON_WALLET } from '../wrappers/RewardVault';
import { AdminActionDescriptor, startAdminActionFlow } from './deployFlow';
import { buildOrderRequest } from './multisigOrder';
import { buildTestClaimRequest } from './testClaim';
import { beginCell, toNano } from '@ton/core';
import { computeRouterAddress, buildRouterDeployRequest } from './routerDeploy';
import { Router, OP_SET_REWARD_JETTON_WALLET } from '../wrappers/Router';
import { computeSkipCollectionAddress, buildSkipCollectionDeployRequest } from './skipCollectionDeploy';
import { SkipCollection } from '../wrappers/SkipCollection';

// Real, already-deployed, already-verified -- see the commits that deployed each.
// New Vault redeployed with admin = real multisig (EQAHjBAJD8C...) and real oracle pubkey.
// Old Vault (EQDQtaxAZAtwpOIxuxdAwODMRvi54KRv0bA2xrDZSyq-o8q_) is abandoned -- no funds.
const VAULT_ADDRESS = Address.parse('EQChmU-QXMNCWc4VY38XyZ_ut5ncNFFJqwuqoCjQLb6twj3j');
const VAULT_JETTON_WALLET = Address.parse('EQBc7CAF9j-ccZOLaBRSgRTtk-kbgsaKNyRCi8gDz_3EbR-E'); // TODO: recompute via jetton master's get_wallet_address for new VAULT_ADDRESS -- SetJettonWallet used this; verify on-chain it matches

const LOCKER_ADDRESS = Address.parse('EQDm9gqYl7hFJSvJLigx-itfoGgZ-4hUwnQ3soNsDmcU6ick');
const ROUTER_JETTON_WALLET_PLACEHOLDER = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');

// The real, correctly-compiled multisig -- see the commit that redeployed it after the
// toolchain-mismatch incident. EQDjHFKV_zZ1fATzlktn1Nqq1bAvSJDns3S-FKjlFtTLlEvg (the first
// deploy) is abandoned: same source, wrong FunC compiler version, code hash didn't match
// what multisig.ton.org and (likely) wallet-side contract checks expect. Not repointed to,
// replaced -- admin is immutable everywhere anyway, so anything built against the old
// address needs redeploying regardless.
const MULTISIG_ADDRESS = Address.parse('EQAHjBAJD8C_kdO3K9Lv7vAnwJttFRS3pxxW5N3yMNY02OcO');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in .env');

const bot = new Bot(token);
const client = new TonClient4({ endpoint: 'https://mainnet-v4.tonhubapi.com' });

// grammy throws if you register a new listener from within another listener (it'd leak a
// new one on every /deploy_multisig) — so confirm_deploy is registered once at the top
// level below, and this map hands it the per-chat state it needs instead.
type PendingDeploy = {
    owner: Address;
    multisig: Multisig;
    address: Address;
    connector: ReturnType<typeof createConnector>;
};
const pendingDeploys = new Map<number, PendingDeploy>();

function loadCode(name: string): Cell {
    const artifact = JSON.parse(fs.readFileSync(__dirname + `/../build/${name}.compiled.json`, 'utf8'));
    return Cell.fromBoc(Buffer.from(artifact.hex, 'hex'))[0];
}

function log(msg: string) {
    console.log(`[FLOW] ${msg}`);
}

async function isActive(address: Address): Promise<boolean> {
    const last = await client.getLastBlock();
    const acc = await client.getAccount(last.last.seqno, address);
    return acc.account.state.type === 'active';
}

bot.command('start', async (ctx) => {
    await ctx.reply(
        'TONkAS admin bot.\n\n' +
            '/deploy_multisig — deploy the real 1-of-1 multisig on MAINNET\n' +
            '  (done: EQAHjBAJD8C_kdO3K9Lv7vAnwJttFRS3pxxW5N3yMNY02OcO — correct func-js version, code hash d3d14da9)\n\n' +
            '/deploy_registry — deploy SlotRegistry with admin = real multisig\n' +
            '/deploy_vault — deploy RewardVault with admin = real multisig, real oracle pubkey\n' +
            '/deploy_locker — deploy LiquidityLocker on MAINNET\n' +
            '/deploy_router — deploy Router with admin = real multisig\n\n' +
            '/set_vault_jetton_wallet — multisig order: set RewardVault.jettonWallet (after Vault is live)\n' +
            '/set_router_jetton_wallet — multisig order: set Router.rewardJettonWallet (after Router is live)\n' +
            '/deploy_skip_collection — deploy the SkipCollection (both 24h + Forever tiers)\n' +
            '/unpause_vault — multisig order: unpause RewardVault to allow claims\n' +
            '/test_claim — execute an oracle-signed claim for 1 token\n\n' +
            'Each spends real TON and is irreversible.'
    );
});

bot.command('deploy_locker', async (ctx) => {
    log(`/deploy_locker received from chat ${ctx.chat.id}`);
    if (!fs.existsSync(__dirname + '/../build/LiquidityLocker.compiled.json')) {
        await ctx.reply('LiquidityLocker.compiled.json not found — run `npx blueprint build LiquidityLocker` first.');
        return;
    }
    const lockerCode = loadCode('LiquidityLocker');
    const { locker, address } = computeLockerAddress(lockerCode);
    
    // We compute the router address here as well to check if it's already live.
    const routerCode = loadCode('Router');
    const { address: routerAddr } = computeRouterAddress(MULTISIG_ADDRESS, locker.address, ROUTER_JETTON_WALLET_PLACEHOLDER, routerCode);

    const descriptor: DeployDescriptor = {
        name: 'LiquidityLocker',
        address,
        describe: () =>
            `Computed LiquidityLocker address: ${address.toString()}\n` +
            `No admin, no privileged functions — deployer identity doesn't matter to the contract's own logic.`,
        buildRequest: (owner) => buildLockerDeployRequest(locker, owner),
        spendWarning: '~0.05 TON',
        verify: async (client, addr) => {
            const opened = client.open(LiquidityLocker.createFromAddress(addr));
            const isLpLocker = await opened.getIsLpLocker();
            if (!isLpLocker) throw new Error('isLpLocker() returned false — code deployed but marker check failed');
            return `isLpLocker() confirmed true.`;
        },
    };

    await startDeployFlow(bot, ctx, descriptor);
});

bot.command('deploy_registry', async (ctx) => {
    log(`/deploy_registry received from chat ${ctx.chat.id}`);
    if (!fs.existsSync(__dirname + '/../build/SlotRegistry.compiled.json') || !fs.existsSync(__dirname + '/../build/SlotAccount.compiled.json')) {
        await ctx.reply('SlotRegistry/SlotAccount build artifacts not found — run `npx blueprint build SlotRegistry` and `SlotAccount` first.');
        return;
    }
    const registryCode = loadCode('SlotRegistry');
    const accountCode = loadCode('SlotAccount');
    const { registry, address } = computeRegistryAddress(MULTISIG_ADDRESS, registryCode, accountCode);

    // Funded from the multisig's own balance, not the connected wallet -- the deploy is
    // wrapped as a send_message action (carrying the full stateInit) inside a multisig
    // order. multisig.ton.org's own order UI can't do this (checked directly: no stateInit
    // field on any of its order types), so this has to go through our own tooling.
    const descriptor: AdminActionDescriptor = {
        name: 'DeployRegistryViaMultisig',
        describe: () =>
            `Multisig order: deploy SlotRegistry (funded from the multisig's own balance)\n` +
            `Computed address: ${address.toString()}\n` +
            `admin: ${MULTISIG_ADDRESS.toString()} (real multisig)\n` +
            `router: ${MULTISIG_ADDRESS.toString()} (placeholder until Router deploys in Step 5, then SetRouter)\n` +
            `curve: basePrice ${CURVE.basePrice} nanoTON, ${CURVE.num}/${CURVE.den} (=1.15), maxSlots ${CURVE.maxSlots}\n` +
            `paused: false`,
        buildRequest: (owner) => {
            if (!registry.init) throw new Error('registry.init missing');
            return buildOrderRequest(MULTISIG_ADDRESS, address, toNano('0.1'), beginCell().endCell(), owner, registry.init);
        },
        spendWarning: '~0.15 TON order overhead (from your wallet) + ~0.1 TON deploy value (from the multisig)',
        poll: async (client) => {
            const last = await client.getLastBlock();
            const acc = await client.getAccount(last.last.seqno, address);
            if (acc.account.state.type !== 'active') return null;

            const opened = client.open(SlotRegistry.createFromAddress(address));
            const admin = await opened.getAdminAddress();
            const curve = await opened.getCurveParams();
            const paused = await opened.getIsPaused();
            if (!admin.equals(MULTISIG_ADDRESS)) throw new Error(`admin mismatch: got ${admin.toString()}`);
            if (curve.basePrice !== CURVE.basePrice || curve.num !== CURVE.num || curve.den !== CURVE.den || curve.maxSlots !== CURVE.maxSlots) {
                throw new Error(`curve mismatch: got ${JSON.stringify(curve, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
            }
            return (
                `${address.toString()}\nhttps://tonviewer.com/${address.toString()}\n\n` +
                `admin confirmed = real multisig.\n` +
                `curve confirmed: basePrice ${curve.basePrice}, ${curve.num}/${curve.den}, maxSlots ${curve.maxSlots}.\n` +
                `paused: ${paused}`
            );
        },
    };

    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('deploy_vault', async (ctx) => {
    log(`/deploy_vault received from chat ${ctx.chat.id}`);
    if (!fs.existsSync(__dirname + '/../build/RewardVault.compiled.json') || !fs.existsSync(__dirname + '/../build/ClaimAccount.compiled.json')) {
        await ctx.reply('RewardVault/ClaimAccount build artifacts not found — run `npx blueprint build RewardVault` and `ClaimAccount` first.');
        return;
    }
    const vaultCode = loadCode('RewardVault');
    const claimAccountCode = loadCode('ClaimAccount');
    const { vault, address } = computeVaultAddress(MULTISIG_ADDRESS, vaultCode, claimAccountCode);

    const descriptor: DeployDescriptor = {
        name: 'RewardVault',
        address,
        describe: () =>
            `Computed RewardVault address: ${address.toString()}\n` +
            `admin: ${MULTISIG_ADDRESS.toString()} (real multisig)\n` +
            `signerKey: ${ORACLE_SIGNER_KEY.toString(16)} (real oracle from Step 0)\n` +
            `jettonWallet: placeholder (multisig) — SetJettonWallet once computed\n` +
            `halvingInterval: ${HALVING_INTERVAL} baseRate: ${BASE_RATE} maxPerClaim: ${MAX_PER_CLAIM}\n` +
            `bucketCapacity: ${BUCKET_CAPACITY} (PROVISIONAL, confirmed for this deploy — see docs/tokenomics.md)\n` +
            `paused: true`,
        buildRequest: (owner) => buildVaultDeployRequest(vault, owner),
        spendWarning: '~0.05 TON',
        verify: async (client, addr) => {
            const opened = client.open(RewardVault.createFromAddress(addr));
            const admin = await opened.getAdminAddress();
            const signerKey = await opened.getSignerKey();
            const paused = await opened.getIsPaused();
            const epochRate = await opened.getCurrentEpochRate();
            const bucket = await opened.getBucketState();
            if (!admin.equals(MULTISIG_ADDRESS)) throw new Error(`admin mismatch: got ${admin.toString()}`);
            if (signerKey !== ORACLE_SIGNER_KEY) throw new Error(`signerKey mismatch: got ${signerKey.toString(16)}`);
            if (epochRate !== BASE_RATE) throw new Error(`currentEpochRate mismatch: got ${epochRate} expected ${BASE_RATE} (epoch 0 should equal baseRate)`);
            if (bucket.capacity !== BUCKET_CAPACITY) throw new Error(`bucket capacity mismatch: got ${bucket.capacity}`);
            return (
                `admin confirmed = real multisig.\n` +
                `signerKey confirmed = real oracle pubkey.\n` +
                `currentEpochRate confirmed = baseRate (epoch 0).\n` +
                `bucket: capacity ${bucket.capacity}, available ${bucket.available}.\n` +
                `paused: ${paused}\n\n` +
                `NOT YET DONE: SetJettonWallet, and a real test claim before the 9B transfer — separate follow-up.`
            );
        },
    };

    await startDeployFlow(bot, ctx, descriptor);
});

bot.command('debug_trivial_send', async (ctx) => {
    log(`/debug_trivial_send received from chat ${ctx.chat.id}`);
    const descriptor: AdminActionDescriptor = {
        name: 'DebugTrivialSend',
        describe: () => `Diagnostic: send 0.01 TON with a plain text comment body directly to the multisig (${MULTISIG_ADDRESS.toString()}). No multisig opcode involved -- isolating whether the issue is "sending to the multisig at all" vs "the new_order payload specifically."`,
        buildRequest: (owner) => ({
            validUntil: Math.floor(Date.now() / 1000) + 280,
            from: owner.toRawString(),
            messages: [
                {
                    address: MULTISIG_ADDRESS.toString(),
                    amount: toNano('0.01').toString(),
                    payload: beginCell().storeUint(0, 32).storeStringTail('diagnostic').endCell().toBoc().toString('base64'),
                },
            ],
        }),
        spendWarning: '~0.01 TON',
        poll: async () => 'sent (this diagnostic has no on-chain effect to verify — success means the wallet accepted and broadcast it)',
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

function setVaultJettonWalletDescriptor(): AdminActionDescriptor {
    return {
        name: 'SetVaultJettonWallet',
        describe: () =>
            `Multisig order: RewardVault.SetJettonWallet(${VAULT_JETTON_WALLET.toString()})\n` +
            `Target: ${VAULT_ADDRESS.toString()}\n` +
            `Computed via the real jetton master's get_wallet_address for the Vault's own address.`,
        buildRequest: (owner) => {
            const body = beginCell().storeUint(OP_SET_JETTON_WALLET, 32).storeAddress(VAULT_JETTON_WALLET).endCell();
            return buildOrderRequest(MULTISIG_ADDRESS, VAULT_ADDRESS, toNano('0.1'), body, owner);
        },
        spendWarning: '~0.15 TON (order overhead; most refunds to the multisig)',
        poll: async (client) => {
            const opened = client.open(RewardVault.createFromAddress(VAULT_ADDRESS));
            const current = await opened.getJettonWalletAddress();
            if (!current.equals(VAULT_JETTON_WALLET)) return null; // order not yet executed
            return `RewardVault.jettonWallet = ${current.toString()}`;
        },
    };
}

bot.command('set_vault_jetton_wallet', async (ctx) => {
    log(`/set_vault_jetton_wallet received from chat ${ctx.chat.id}`);
    await startAdminActionFlow(bot, ctx, setVaultJettonWalletDescriptor());
});

// Diagnostic: same exact order, routed through Tonkeeper instead of Telegram Wallet, to
// isolate "something about this request" from "something about this wallet app" -- see the
// debugging trail in the commit that added this for the full context.
bot.command('set_vault_jetton_wallet_tonkeeper', async (ctx) => {
    log(`/set_vault_jetton_wallet_tonkeeper received from chat ${ctx.chat.id}`);
    await startAdminActionFlow(bot, ctx, setVaultJettonWalletDescriptor(), 'tonkeeper');
});

bot.command('deploy_multisig', async (ctx) => {
    log(`/deploy_multisig received from chat ${ctx.chat.id}`);
    const chatId = ctx.chat.id;

    const existingCode = fs.existsSync(__dirname + '/../build/Multisig.compiled.json');
    if (!existingCode) {
        await ctx.reply('Multisig.compiled.json not found — run `npx blueprint build Multisig` first.');
        return;
    }
    const multisigCode = loadCode('Multisig');

    const connector = createConnector(chatId);

    // Resume an already-connected session rather than forcing a fresh connect every time.
    await connector.restoreConnection().catch(() => {});
    if (connector.connected && connector.wallet) {
        log(`restored existing connection: ${connector.wallet.account.address}`);
        await ctx.reply(`Already connected: ${connector.wallet.account.address}`);
        await proceedToDeploy(ctx, connector.wallet.account.address, multisigCode, connector);
        return;
    }

    const link = getConnectLink(connector);
    log(`generated connect link, sending Connect Wallet button`);
    const kb = new InlineKeyboard().url('Connect Wallet', link);
    await ctx.reply('Tap to connect your Telegram Wallet:', { reply_markup: kb });

    try {
        const wallet = await waitForConnection(connector);
        log(`WALLET CONNECTED: ${wallet.account.address}`);
        await ctx.reply(`Connected: ${wallet.account.address}`);
        await proceedToDeploy(ctx, wallet.account.address, multisigCode, connector);
    } catch (e: any) {
        log(`CONNECTION FAILED: ${e.message}`);
        await ctx.reply(`Connection failed or timed out: ${e.message}`);
    }
});

async function proceedToDeploy(ctx: any, rawAddress: string, multisigCode: Cell, connector: ReturnType<typeof createConnector>) {
    const owner = Address.parseRaw(rawAddress);
    const { multisig, address } = computeMultisigAddress(owner, multisigCode);
    const config = buildMultisigConfig(owner);
    log(`computed multisig address ${address.toString()} for owner ${owner.toString()}`);

    pendingDeploys.set(ctx.chat.id, { owner, multisig, address, connector });

    await ctx.reply(
        `Computed multisig address: ${address.toString()}\n` +
            `Config: threshold ${config.threshold} of ${config.signers.length} signer(s) — ${owner.toString()}\n\n` +
            `Tap Deploy to review and sign in your wallet. This spends ~0.1 TON and cannot be undone.`,
        { reply_markup: new InlineKeyboard().text('Deploy Multisig', 'confirm_deploy') }
    );
}

bot.callbackQuery('confirm_deploy', async (cbCtx) => {
    const pending = pendingDeploys.get(cbCtx.chat!.id);
    if (!pending) {
        await cbCtx.answerCallbackQuery();
        await cbCtx.reply('No pending deploy for this chat — run /deploy_multisig again.');
        return;
    }
    const { owner, multisig, address, connector } = pending;

    log('Deploy Multisig tapped, sending transaction request over the bridge');
    await cbCtx.answerCallbackQuery();
    const request = buildDeployRequest(multisig, owner);

    const resultPromise = requestTransaction(connector, request);
    const reopenKb = new InlineKeyboard().url('Review & Sign in Wallet', getReopenWalletLink());
    await cbCtx.reply('Request sent to your wallet. Tap to review:', { reply_markup: reopenKb });

    try {
        await resultPromise;
        log('WALLET SIGNED AND SENT the deploy transaction');
        await cbCtx.reply('Wallet reported the transaction as sent. Confirming on-chain — this can take a bit...');
    } catch (e: any) {
        log(`WALLET REJECTED OR FAILED: ${e.message}`);
        await cbCtx.reply(`Wallet did not complete the transaction: ${e.message}`);
        return;
    }

    // Don't report success on "sent" alone — poll until the multisig is actually
    // active on-chain, then verify it's actually owned by the connected wallet.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
        if (await isActive(address)) break;
        await new Promise((r) => setTimeout(r, 5000));
    }

    if (!(await isActive(address))) {
        log(`NOT ACTIVE after 5 minutes: ${address.toString()}`);
        await cbCtx.reply(`Still not active on-chain after 5 minutes: ${address.toString()}. Check manually before assuming this failed.`);
        return;
    }

    // Read back real on-chain config (not our locally-computed one) to confirm it
    // actually matches — this is the "actually owned by the connected wallet" check.
    const last = await client.getLastBlock();
    const result = await client.runMethod(last.last.seqno, address, 'get_multisig_data', []);
    log(`CONFIRMED LIVE: ${address.toString()} exitCode=${result.exitCode}`);
    pendingDeploys.delete(cbCtx.chat!.id);
    await cbCtx.reply(
        `Confirmed live on-chain: ${address.toString()}\n` +
            `https://tonviewer.com/${address.toString()}\n\n` +
            `get_multisig_data exit code: ${result.exitCode}\n` +
            `Raw result: ${JSON.stringify(result.result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`
    );
});

bot.command('test_claim', async (ctx) => {
    log(`/test_claim received from chat ${ctx.chat.id}`);
    const descriptor: AdminActionDescriptor = {
        name: 'TestClaim',
        describe: (owner) =>
            `Oracle-signed test claim on new Vault.\n` +
            `Vault: ${VAULT_ADDRESS.toString()}\n` +
            `Claimant: ${owner.toString()}\n` +
            `Amount: 1 token (1_000_000_000 nanotoken)\n\n` +
            `This exercises the full verification path: oracle signs → Vault checks signature + elapsed-time bound → pays out via jetton transfer.\n` +
            `Vault must be unpaused first (it is currently paused — unpause after confirming this works).`,
        buildRequest: async (owner) => {
            return buildTestClaimRequest(VAULT_ADDRESS, owner, owner);
        },
        spendWarning: '~0.3 TON gas',
        poll: async (client) => {
            // Verify the ClaimAccount under this wallet was created and has a lastClaimTime set.
            const last = await client.getLastBlock();
            const vaultOpened = client.open(RewardVault.createFromAddress(VAULT_ADDRESS));
            // We can't easily get the claimant address here (owner is not in scope of poll),
            // so poll cumulativeMined on the Vault -- it increments on every successful claim.
            const mined = await vaultOpened.getCumulativeMined();
            if (mined === 0n) return null; // claim not yet processed
            return `cumulativeMined = ${mined} — claim landed. Vault is exercised end-to-end.`;
        },
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('unpause_vault', async (ctx) => {
    log(`/unpause_vault received from chat ${ctx.chat.id}`);
    const descriptor: AdminActionDescriptor = {
        name: 'UnpauseVault',
        describe: (owner) =>
            `Multisig order: RewardVault.SetPaused(false)\n` +
            `Target: ${VAULT_ADDRESS.toString()}\n` +
            `Unpauses the Vault so claims can be processed.`,
        buildRequest: async (owner) => {
            // OP_SET_PAUSED = 0x80005206
            const body = beginCell().storeUint(0x80005206, 32).storeBit(false).endCell();
            return buildOrderRequest(MULTISIG_ADDRESS, VAULT_ADDRESS, toNano('0.1'), body, owner);
        },
        spendWarning: '~0.15 TON (order overhead)',
        poll: async (client) => {
            const opened = client.open(RewardVault.createFromAddress(VAULT_ADDRESS));
            const paused = await opened.getIsPaused();
            if (paused) return null; // not yet executed
            return `RewardVault.isPaused = false`;
        },
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('deploy_router', async (ctx) => {
    log(`/deploy_router received from chat ${ctx.chat.id}`);
    const routerCode = loadCode('Router');
    // Using placeholder for rewardJettonWallet to break the circular dependency. We will set it later.
    const { router, address } = computeRouterAddress(MULTISIG_ADDRESS, LOCKER_ADDRESS, ROUTER_JETTON_WALLET_PLACEHOLDER, routerCode);

    const descriptor: DeployDescriptor = {
        name: 'Router',
        address,
        describe: (owner) =>
            `Computed Address: ${address.toString()}\n\n` +
            `Admin: ${MULTISIG_ADDRESS.toString()}\n` +
            `Locker: ${LOCKER_ADDRESS.toString()}\n` +
            `Jetton Wallet: Placeholder (will update via SetRewardJettonWallet)`,
        buildRequest: async (owner) => buildRouterDeployRequest(router, owner),
        spendWarning: '0.05 TON (deploy cost)',
        verify: async (client, addr) => {
            const opened = client.open(Router.createFromAddress(addr));
            const state = await opened.getCycleState();
            const admin = await opened.getAdminAddress();
            if (!admin.equals(MULTISIG_ADDRESS)) throw new Error(`admin mismatch: got ${admin.toString()}`);
            return `Router live! admin confirmed = real multisig. State = ${state.state}`;
        },
    };
    await startDeployFlow(bot, ctx, descriptor);
});

bot.command('set_router_jetton_wallet', async (ctx) => {
    log(`/set_router_jetton_wallet received from chat ${ctx.chat.id}`);
    const routerCode = loadCode('Router');
    const { address } = computeRouterAddress(MULTISIG_ADDRESS, LOCKER_ADDRESS, ROUTER_JETTON_WALLET_PLACEHOLDER, routerCode);

    // Computed once up front, not on every buildRequest/poll call -- also lets describe()
    // show the real target value before anyone taps Deploy, not just "trust me".
    const jettonMaster = Address.parse('EQBF6stfWMsDvkEOm2pqKs0C4rU0RRU_fdRDmIgo_sDVpShl'); // TONkAS
    const last = await client.getLastBlock();
    const jwRes = await client.runMethod(last.last.seqno, jettonMaster, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(address).endCell() },
    ]);
    const computedWallet = jwRes.reader.readAddress();

    const descriptor: AdminActionDescriptor = {
        name: 'SetRouterJettonWallet',
        describe: () =>
            `Multisig order: Router.SetRewardJettonWallet(${computedWallet.toString()})\n` +
            `Target: ${address.toString()}\n` +
            `Computed via the real jetton master's get_wallet_address for the Router's own address.`,
        buildRequest: (owner) => {
            const body = beginCell().storeUint(OP_SET_REWARD_JETTON_WALLET, 32).storeAddress(computedWallet).endCell();
            return buildOrderRequest(MULTISIG_ADDRESS, address, toNano('0.1'), body, owner);
        },
        spendWarning: '~0.15 TON (order overhead)',
        // Actually reads the real get-method and compares against the real computed
        // target -- the previous version of this command always reported success
        // unconditionally without checking anything. See the oracle-reconciliation
        // incident's notes for why that pattern is dangerous: it happened to be right
        // here (independently reconfirmed after the fact), but that was luck, not proof.
        poll: async (client) => {
            const opened = client.open(Router.createFromAddress(address));
            const current = await opened.getRewardJettonWalletAddress();
            if (!current.equals(computedWallet)) return null;
            return `Router.rewardJettonWallet = ${current.toString()}`;
        },
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('set_vault_signer', async (ctx) => {
    log(`/set_vault_signer received from chat ${ctx.chat.id}`);
    const descriptor: AdminActionDescriptor = {
        name: 'SetVaultSigner',
        describe: () =>
            `Multisig order: RewardVault.SetSignerKey\n` +
            `Target: ${VAULT_ADDRESS.toString()}\n` +
            `This updates the Vault's oracle signer key to match the new seed.`,
        buildRequest: async (owner) => {
            const OP_SET_SIGNER_KEY = 0x80005205;
            const body = beginCell().storeUint(OP_SET_SIGNER_KEY, 32).storeUint(ORACLE_SIGNER_KEY, 256).endCell();
            return buildOrderRequest(MULTISIG_ADDRESS, VAULT_ADDRESS, toNano('0.1'), body, owner);
        },
        spendWarning: '~0.15 TON (order overhead)',
        poll: async (client) => {
            const opened = client.open(RewardVault.createFromAddress(VAULT_ADDRESS));
            const signer = await opened.getSignerKey();
            if (signer !== ORACLE_SIGNER_KEY) return null;
            return `Vault signer key successfully updated to the new key!`;
        },
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('transfer_to_personal', async (ctx) => {
    log(`/transfer_to_personal received from chat ${ctx.chat.id}`);
    const PERSONAL_WALLET = Address.parse('UQDZlnNRydIutcTUJFgm6Mggnu79-JIzpr1uoMg9qqW7OE4J');
    const TRANSFER_AMOUNT = toNano('2');

    // Snapshot the "before" balance once, at command time, so poll can confirm the transfer
    // actually landed rather than just that the order executed -- the multisig succeeding
    // at its own bookkeeping isn't the same as the money actually arriving.
    const last0 = await client.getLastBlock();
    const before = await client.getAccount(last0.last.seqno, PERSONAL_WALLET);
    const beforeBalance = BigInt(before.account.balance.coins);

    const descriptor: AdminActionDescriptor = {
        name: 'TransferToPersonal',
        describe: () =>
            `Multisig order: transfer ${TRANSFER_AMOUNT} nanoTON (2 TON) from the multisig to your personal wallet.\n` +
            `From: ${MULTISIG_ADDRESS.toString()}\n` +
            `To: ${PERSONAL_WALLET.toString()}\n` +
            `Personal wallet balance right now: ${(Number(beforeBalance) / 1e9).toFixed(6)} TON`,
        // targetValue is the actual 2 TON drawn from the multisig's own pre-existing
        // balance -- not covered by ORDER_VALUE, which only pays the multisig's own small
        // order-processing overhead. Empty body -- plain transfer, no comment needed.
        buildRequest: (owner) => buildOrderRequest(MULTISIG_ADDRESS, PERSONAL_WALLET, TRANSFER_AMOUNT, beginCell().endCell(), owner),
        spendWarning: '~0.15 TON order overhead (from your wallet) + 2 TON transferred (from the multisig)',
        poll: async (client) => {
            const last = await client.getLastBlock();
            const after = await client.getAccount(last.last.seqno, PERSONAL_WALLET);
            const afterBalance = BigInt(after.account.balance.coins);
            const delta = afterBalance - beforeBalance;
            // Real transfers lose a little to forwarding fees on receipt; require most of
            // the 2 TON to have actually landed, not the exact full amount.
            if (delta < toNano('1.9')) return null;
            return (
                `Personal wallet balance: ${(Number(beforeBalance) / 1e9).toFixed(6)} TON -> ${(Number(afterBalance) / 1e9).toFixed(6)} TON ` +
                `(+${(Number(delta) / 1e9).toFixed(6)} TON)`
            );
        },
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('set_collection_signer', async (ctx) => {
    log(`/set_collection_signer received from chat ${ctx.chat.id}`);
    const collAddr = Address.parse('EQB2pjIBqzdBaQFTWS7ufvFNr_zLqp-092Ls5iWO0mWRlx_n');
    const descriptor: AdminActionDescriptor = {
        name: 'SetCollectionSigner',
        describe: () =>
            `Multisig order: SkipCollection.SetSignerKey\n` +
            `Target: ${collAddr.toString()}\n` +
            `This updates the SkipCollection's oracle signer key to match the new seed.`,
        buildRequest: async (owner) => {
            const OP_SET_SIGNER_KEY = 0x80005304;
            const body = beginCell().storeUint(OP_SET_SIGNER_KEY, 32).storeUint(ORACLE_SIGNER_KEY, 256).endCell();
            return buildOrderRequest(MULTISIG_ADDRESS, collAddr, toNano('0.1'), body, owner);
        },
        spendWarning: '~0.15 TON (order overhead)',
        poll: async (client) => {
            // getCollectionData doesn't carry signerKey -- SkipCollection.tolk exposes it via
            // its own `get fun signerKey(): int` getter, called directly here since the
            // wrapper doesn't have a typed method for it yet.
            const last = await client.getLastBlock();
            const res = await client.runMethod(last.last.seqno, collAddr, 'signerKey', []);
            const signer = res.reader.readBigNumber();
            if (signer !== ORACLE_SIGNER_KEY) return null;
            return `SkipCollection.signerKey = ${signer.toString(16)}`;
        },
    };
    await startAdminActionFlow(bot, ctx, descriptor);
});

bot.command('deploy_skip_collection', async (ctx) => {
    log(`/deploy_skip_collection received from chat ${ctx.chat.id}`);
    if (!fs.existsSync(__dirname + '/../build/SkipCollection.compiled.json')) {
        await ctx.reply('SkipCollection.compiled.json not found — run `npx blueprint build SkipCollection` first.');
        return;
    }
    if (!fs.existsSync(__dirname + '/../build/SkipItem.compiled.json')) {
        await ctx.reply('SkipItem.compiled.json not found — run `npx blueprint build SkipItem` first.');
        return;
    }
    if (!fs.existsSync(__dirname + '/../build/ReferralAccount.compiled.json')) {
        await ctx.reply('ReferralAccount.compiled.json not found — run `npx blueprint build ReferralAccount` first.');
        return;
    }

    const collectionCode = loadCode('SkipCollection');
    const itemCode = loadCode('SkipItem');
    const referralAccountCode = loadCode('ReferralAccount');

    // Router address -- computed deterministically from its config.
    const routerCode = loadCode('Router');
    const { address: routerAddress } = computeRouterAddress(
        MULTISIG_ADDRESS,
        LOCKER_ADDRESS,
        ROUTER_JETTON_WALLET_PLACEHOLDER,
        routerCode,
    );

    const { collection, address } = computeSkipCollectionAddress(
        MULTISIG_ADDRESS,
        routerAddress,
        collectionCode,
        itemCode,
        referralAccountCode,
    );

    const descriptor: DeployDescriptor = {
        name: 'SkipCollection',
        address,
        describe: (owner) =>
            `Computed Address: ${address.toString()}\n\n` +
            `Admin: ${MULTISIG_ADDRESS.toString()}\n` +
            `Router: ${routerAddress.toString()}\n` +
            `Oracle signerKey: real key\n` +
            `Free-mint cap: 2000/day\n` +
            `24h art: IPFS pinata\n` +
            `Forever art: IPFS pinata\n` +
            `Starts: unpaused (no jetton balance required, mint is TON-only)`,
        buildRequest: async (owner) => buildSkipCollectionDeployRequest(collection, owner),
        spendWarning: '0.05 TON (deploy cost)',
        verify: async (client, addr) => {
            const opened = client.open(SkipCollection.createFromAddress(addr));
            const data = await opened.getCollectionData();
            const admin = data.admin;
            if (!admin.equals(MULTISIG_ADDRESS)) throw new Error(`admin mismatch: got ${admin.toString()}`);
            return `SkipCollection live! nextItemIndex=${data.nextItemIndex}, admin confirmed = real multisig.`;
        },
    };
    await startDeployFlow(bot, ctx, descriptor);
});

registerDeployCallbacks(bot, client);

bot.catch((err) => {
    log(`UNHANDLED BOT ERROR: ${err.message}`);
});

bot.start();
console.log('Bot running. Message @tonkasminerbot with /deploy_multisig.');
