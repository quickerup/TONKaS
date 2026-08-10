// ============================================================
// TONkAS Game Bot — Cloudflare Worker (webhook, no polling)
// All interaction in-chat, no mini app.
// ============================================================

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { sign, keyPairFromSeed } from '@ton/crypto';
import type { KVNamespace } from '@cloudflare/workers-types';

// ─── Constants ───────────────────────────────────────────────
const VAULT_ADDRESS       = 'EQChmU-QXMNCWc4VY38XyZ_ut5ncNFFJqwuqoCjQLb6twj3j';
const REGISTRY_ADDRESS    = ''; // set via env REGISTRY_ADDRESS
const COLLECTION_ADDRESS  = ''; // set via env COLLECTION_ADDRESS
const ROUTER_ADDRESS      = ''; // set via env ROUTER_ADDRESS
const LOCKER_ADDRESS      = 'EQDm9gqYl7hFJSvJLigx-itfoGgZ-4hUwnQ3soNsDmcU6ick';
const JETTON_MASTER       = 'EQBF6stfWMsDvkEOm2pqKs0C4rU0RRU_fdRDmIgo_sDVpShl';
const STONFI_POOL         = 'EQAFGrQk5fPoDK-bhjyW89Z_hnaNOAmlOGtEQW1Y1vK8GDFk';
const TONVIEWER           = 'https://tonviewer.com';

// GitHub raw URLs
const MINER_OFF_URL = 'https://raw.githubusercontent.com/quickerup/TONKaS/main/assets/main/miner-off.jpg';
const MINER_ON_URL  = 'https://raw.githubusercontent.com/quickerup/TONKaS/main/assets/main/miner-on.gif';

// KV key prefixes
const KV_WALLET    = (uid: number) => `wallet:${uid}`;
const KV_LAST_MINE = (uid: number) => `mine:${uid}`;
const KV_SLOTS     = (uid: number) => `slots:${uid}`;
const KV_NONCE     = (uid: number) => `nonce:${uid}`;
const KV_REFERRER  = (uid: number) => `ref:${uid}`;

const CLAIM_ATTESTATION_MAGIC   = 0x52565431;
const REFERRAL_ATTESTATION_MAGIC = 0x52464d31;
const MINE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ─── Env interface ────────────────────────────────────────────
export interface Env {
    BOT_TOKEN: string;
    ORACLE_SEED: string;
    DB: KVNamespace;
    REGISTRY_ADDRESS?: string;
    COLLECTION_ADDRESS?: string;
    ROUTER_ADDRESS?: string;
}

// ─── Telegram helpers ─────────────────────────────────────────
function tgUrl(token: string, method: string) {
    return `https://api.telegram.org/bot${token}/${method}`;
}

async function callTg(token: string, method: string, body: object) {
    const r = await fetch(tgUrl(token, method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return r.json() as any;
}

function btn(text: string, data: string) {
    return { text, callback_data: data };
}

function urlBtn(text: string, url: string) {
    return { text, url };
}

function mainKeyboard(minerOn: boolean) {
    return {
        inline_keyboard: [
            [
                btn(minerOn ? '⛏️ Mine Now!' : '⛏️ Start Mining', 'mine'),
                btn('💰 Claim Rewards', 'claim'),
            ],
            [
                btn('🎰 Buy Slot', 'buy_slot'),
                btn('⏱️ 24h Skip — 5 TON', 'buy_24h'),
                btn('♾️ Forever Skip — 10 TON', 'buy_forever'),
            ],
            [
                btn('📊 My Stats', 'stats'),
                btn('👥 Refer & Earn', 'refer'),
            ],
            [
                btn('Where does my TON go? 🐸', 'antirug'),
                btn('ℹ️ How it works', 'howto'),
            ],
            [
                btn('🔗 Connect Wallet', 'connect_wallet'),
            ],
        ],
    };
}

function backKeyboard() {
    return { inline_keyboard: [[btn('← Back', 'home')]] };
}

// ─── Oracle signing ───────────────────────────────────────────
function getKeyPair(env: Env) {
    const seed = Buffer.from(env.ORACLE_SEED, 'hex');
    if (seed.length !== 32) throw new Error('ORACLE_SEED invalid');
    return keyPairFromSeed(seed);
}

function buildClaimAttestation(
    vault: Address, claimant: Address,
    amount: bigint, nonce: bigint, validUntil: number
): Cell {
    return beginCell()
        .storeUint(CLAIM_ATTESTATION_MAGIC, 32)
        .storeAddress(vault)
        .storeAddress(claimant)
        .storeCoins(amount)
        .storeUint(nonce, 64)
        .storeUint(validUntil, 32)
        .endCell();
}

function buildReferralAttestation(
    collection: Address, claimant: Address,
    nonce: bigint, validUntil: number
): Cell {
    return beginCell()
        .storeUint(REFERRAL_ATTESTATION_MAGIC, 32)
        .storeAddress(collection)
        .storeAddress(claimant)
        .storeUint(nonce, 64)
        .storeUint(validUntil, 32)
        .endCell();
}

// ─── TON deep-link helpers ────────────────────────────────────
// Generates a ton:// transfer link a wallet will open directly in Telegram
function tonLink(to: string, amountNano: bigint, payloadBase64?: string): string {
    let url = `https://app.tonkeeper.com/transfer/${to}?amount=${amountNano}`;
    if (payloadBase64) url += `&bin=${encodeURIComponent(payloadBase64)}`;
    return url;
}

// ─── KV state helpers ─────────────────────────────────────────
async function getWallet(env: Env, uid: number): Promise<string | null> {
    return env.DB.get(KV_WALLET(uid));
}

async function setWallet(env: Env, uid: number, addr: string) {
    await env.DB.put(KV_WALLET(uid), addr);
}

async function getNextNonce(env: Env, uid: number): Promise<bigint> {
    const n = await env.DB.get(KV_NONCE(uid));
    const next = BigInt(n ?? '0') + 1n;
    await env.DB.put(KV_NONCE(uid), next.toString());
    return next;
}

async function canMine(env: Env, uid: number): Promise<{ ok: boolean; msLeft: number }> {
    const last = await env.DB.get(KV_LAST_MINE(uid));
    if (!last) return { ok: true, msLeft: 0 };
    const elapsed = Date.now() - Number(last);
    if (elapsed >= MINE_COOLDOWN_MS) return { ok: true, msLeft: 0 };
    return { ok: false, msLeft: MINE_COOLDOWN_MS - elapsed };
}

async function recordMine(env: Env, uid: number) {
    await env.DB.put(KV_LAST_MINE(uid), Date.now().toString());
}

function formatCooldown(ms: number): string {
    const m = Math.ceil(ms / 60000);
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}m`;
}

// ─── Message builders ─────────────────────────────────────────
function homeText(minerOn: boolean, wallet: string | null): string {
    return (
        `🐸 *TONkAS Miner*\n\n` +
        (wallet
            ? `🔗 Wallet: \`${wallet.slice(0, 8)}...${wallet.slice(-4)}\`\n`
            : `⚠️ No wallet connected yet — tap Connect Wallet\n`) +
        `\n` +
        (minerOn
            ? `✅ *Miner is ON* — keep pressing every hour to earn!\n`
            : `💤 *Miner is idle* — press Mine Now to activate\n`) +
        `\nEvery hour counts. Every slot earns. 👇`
    );
}

function antiRugText(): string {
    return (
        `🐸 *Where does my TON go?*\n\n` +
        `Every rig, every skip, every slot — your TON doesn't just disappear.\n\n` +
        `🟢 Half buys *$TONkAS straight off the open market.*\n` +
        `🔒 Half gets locked into liquidity. Forever. By contract.\n\n` +
        `*No rug. Here's the proof:*\n` +
        `• LP Locker has *no withdraw function* and *no upgrade path*\n` +
        `• 57.47 Billion tokens *burned* (not locked — gone forever)\n` +
        `• Every new buy *deepens liquidity permanently*\n` +
        `• 9B token reward pool, *hard capped by contract*\n\n` +
        `🔍 Verify yourself:\n`
    );
}

function antiRugKeyboard() {
    return {
        inline_keyboard: [
            [urlBtn('🔒 LP Locker on-chain', `${TONVIEWER}/${LOCKER_ADDRESS}`)],
            [urlBtn('💧 STON.fi Pool', `${TONVIEWER}/${STONFI_POOL}`)],
            [urlBtn('🪙 Jetton Master', `${TONVIEWER}/${JETTON_MASTER}`)],
            [btn('← Back', 'home')],
        ],
    };
}

function howtoText(): string {
    return (
        `ℹ️ *How TONkAS Works*\n\n` +
        `1️⃣ *Connect your wallet* to register\n` +
        `2️⃣ *Buy a slot* (1 TON + geometric curve) — each slot = 1 share per epoch\n` +
        `3️⃣ *Press Mine every hour* to keep your slot active\n` +
        `4️⃣ Every active slot splits the hour's reward budget pro-rata\n` +
        `5️⃣ *Claim your rewards* — oracle verifies, Vault pays $TONkAS\n\n` +
        `⏱️ *Skip NFTs:*\n` +
        `• 24h Skip (5 TON) — one activation covers 24 consecutive epochs\n` +
        `• Forever Skip (10 TON) — always active, never press again\n\n` +
        `👥 *Referrals:* Refer 5 wallets who register + mine once = free Forever Skip NFT\n\n` +
        `📉 *Halvings:* Every 1B tokens mined, reward rate halves. 9B total cap.\n`
    );
}

function statsText(wallet: string | null, lastMine: string | null, canMineNow: boolean): string {
    const mineStatus = canMineNow
        ? '✅ Ready to mine!'
        : `⏳ Next mine available in: cooldown active`;
    return (
        `📊 *Your Stats*\n\n` +
        `🔗 Wallet: ${wallet ? `\`${wallet.slice(0, 10)}...${wallet.slice(-4)}\`` : 'Not connected'}\n` +
        `⛏️ Last mine: ${lastMine ? new Date(Number(lastMine)).toUTCString() : 'Never'}\n` +
        `${mineStatus}\n\n` +
        `Tip: Buy more slots to earn a bigger share of each epoch's reward.`
    );
}

function referText(uid: number, botUsername: string): string {
    const link = `https://t.me/${botUsername}?start=ref_${uid}`;
    return (
        `👥 *Refer & Earn*\n\n` +
        `Share your link. When 5 wallets register *and* mine at least once — you earn a *free Forever Skip NFT.*\n\n` +
        `Your referral link:\n` +
        `\`${link}\`\n\n` +
        `Tap to copy 👆 and share it anywhere.`
    );
}

// ─── Send helpers ─────────────────────────────────────────────
async function sendPhoto(
    token: string, chatId: number, photoUrl: string,
    caption: string, keyboard: object
) {
    return callTg(token, 'sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });
}

async function editOrSendText(
    token: string, chatId: number, messageId: number | undefined,
    text: string, keyboard: object
) {
    if (messageId) {
        return callTg(token, 'editMessageText', {
            chat_id: chatId, message_id: messageId,
            text, parse_mode: 'Markdown', reply_markup: keyboard,
        });
    }
    return callTg(token, 'sendMessage', {
        chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: keyboard,
    });
}

async function answerCbq(token: string, cbqId: string, text?: string, alert = false) {
    return callTg(token, 'answerCallbackQuery', {
        callback_query_id: cbqId,
        text,
        show_alert: alert,
    });
}

// ─── Home screen (with photo) ─────────────────────────────────
async function sendHome(token: string, chatId: number, env: Env, uid: number) {
    const wallet = await getWallet(env, uid);
    const { ok: canMineNow } = await canMine(env, uid);
    const minerOn = canMineNow === false; // miner "on" if they've mined recently
    const lastMine = await env.DB.get(KV_LAST_MINE(uid));
    const isMinerActive = lastMine !== null && !canMineNow;

    return sendPhoto(
        token, chatId,
        isMinerActive ? MINER_ON_URL : MINER_OFF_URL,
        homeText(isMinerActive, wallet),
        mainKeyboard(isMinerActive),
    );
}

// ─── Main handler ─────────────────────────────────────────────
async function handleUpdate(update: any, env: Env) {
    const token = env.BOT_TOKEN;

    // ── /start (with optional ref) ──
    if (update.message) {
        const msg = update.message;
        const chatId: number = msg.chat.id;
        const uid: number = msg.from.id;
        const text: string = msg.text ?? '';

        if (text.startsWith('/start')) {
            const parts = text.split(' ');
            if (parts[1]?.startsWith('ref_')) {
                const referrerId = Number(parts[1].replace('ref_', ''));
                if (referrerId && referrerId !== uid) {
                    await env.DB.put(KV_REFERRER(uid), String(referrerId));
                }
            }
            await sendHome(token, chatId, env, uid);
            return;
        }

        // wallet address submission (plain address message)
        if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(text.trim())) {
            const addr = text.trim();
            await setWallet(env, uid, addr);
            await callTg(token, 'sendMessage', {
                chat_id: chatId,
                text: `✅ Wallet connected!\n\`${addr}\`\n\nYou're ready to mine. Use /start to go back to the main menu.`,
                parse_mode: 'Markdown',
            });
            return;
        }

        return;
    }

    // ── Callback queries ──
    if (update.callback_query) {
        const cbq = update.callback_query;
        const data: string = cbq.data;
        const chatId: number = cbq.message?.chat?.id;
        const uid: number = cbq.from.id;
        const msgId: number = cbq.message?.message_id;

        // ── home ──
        if (data === 'home') {
            await answerCbq(token, cbq.id);
            await sendHome(token, chatId, env, uid);
            return;
        }

        // ── mine ──
        if (data === 'mine') {
            const wallet = await getWallet(env, uid);
            if (!wallet) {
                await answerCbq(token, cbq.id, '⚠️ Connect your wallet first!', true);
                return;
            }
            const { ok, msLeft } = await canMine(env, uid);
            if (!ok) {
                await answerCbq(token, cbq.id, `⏳ On cooldown — ${formatCooldown(msLeft)} left`, true);
                return;
            }
            await recordMine(env, uid);
            await answerCbq(token, cbq.id, '⛏️ Mined! See you in an hour.', false);
            // Refresh home so miner flips to ON state
            await sendHome(token, chatId, env, uid);
            return;
        }

        // ── claim ──
        if (data === 'claim') {
            const wallet = await getWallet(env, uid);
            if (!wallet) {
                await answerCbq(token, cbq.id, '⚠️ Connect your wallet first!', true);
                return;
            }

            await answerCbq(token, cbq.id);

            // Call oracle to get a signed attestation
            try {
                const kp = getKeyPair(env);
                const nonce = await getNextNonce(env, uid);
                const validUntil = Math.floor(Date.now() / 1000) + 600;

                // Amount: oracle determines actual amount from press history.
                // For the in-chat UX, we request a signing from our own oracle endpoint.
                // The worker IS the oracle, so we sign directly here.
                const claimant = Address.parse(wallet);
                const vault = Address.parse(VAULT_ADDRESS);

                // Amount is derived by the contract from elapsed time + epoch rate.
                // We sign for the max theoretical claimable amount (contract will cap it).
                // In production the oracle tracks actual presses; here we sign a probe claim.
                // TODO: integrate press-history DB to compute exact amount.
                const amount = toNano('1'); // 1 TONkAS probe — contract enforces real cap

                const cell = buildClaimAttestation(vault, claimant, amount, nonce, validUntil);
                const signature = sign(cell.hash(), kp.secretKey);

                const attBoc = cell.toBoc().toString('base64');
                const sigHex = signature.toString('hex');

                // Build OP_CLAIM transaction link for Tonkeeper
                // OP_CLAIM = 0x80005201
                const body = beginCell()
                    .storeUint(0x80005201, 32)
                    .storeUint(0n, 64) // queryId
                    .storeRef(cell)
                    .storeRef(beginCell().storeBuffer(signature).endCell())
                    .endCell();

                const payloadB64 = body.toBoc().toString('base64');
                const link = tonLink(VAULT_ADDRESS, toNano('0.1'), payloadB64);

                await callTg(token, 'sendMessage', {
                    chat_id: chatId,
                    text:
                        `💰 *Claim Your Rewards*\n\n` +
                        `Tap the button to open your wallet and submit the claim transaction.\n\n` +
                        `The contract will pay out everything you've earned since your last claim.\n\n` +
                        `ℹ️ Cost: ~0.1 TON gas (refunded as excess)`,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [urlBtn('💸 Claim in Wallet', link)],
                            [btn('← Back', 'home')],
                        ],
                    },
                });
            } catch (e: any) {
                await callTg(token, 'sendMessage', {
                    chat_id: chatId,
                    text: `❌ Oracle error: ${e.message}`,
                });
            }
            return;
        }

        // ── buy slot ──
        if (data === 'buy_slot') {
            await answerCbq(token, cbq.id);
            const regAddr = env.REGISTRY_ADDRESS || REGISTRY_ADDRESS;
            // OP_BUY_SLOT — the registry handles the exact price curve on-chain
            // User sends 2 TON (contract refunds excess above current price)
            const body = beginCell()
                .storeUint(0x80005101, 32) // OP_BUY_SLOT
                .storeUint(0n, 64)
                .endCell();
            const link = tonLink(regAddr, toNano('2'), body.toBoc().toString('base64'));

            await callTg(token, 'sendMessage', {
                chat_id: chatId,
                text:
                    `🎰 *Buy a Mining Slot*\n\n` +
                    `Each slot = 1 extra share per epoch, forever.\n` +
                    `Price follows a geometric curve: *1 TON × 1.15ⁿ*\n\n` +
                    `Send 2 TON — the contract charges exactly what you owe and refunds the rest.\n\n` +
                    `Your TON → buys $TONkAS off STON.fi → LP locked forever 🔒`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [urlBtn('🎰 Buy Slot in Wallet', link)],
                        [btn('← Back', 'home')],
                    ],
                },
            });
            return;
        }

        // ── buy 24h skip ──
        if (data === 'buy_24h') {
            await answerCbq(token, cbq.id);
            const collAddr = env.COLLECTION_ADDRESS || COLLECTION_ADDRESS;
            // OP_PAID_MINT = 0x80005301, tier = 0
            const body = beginCell()
                .storeUint(0x80005301, 32)
                .storeUint(0n, 64)
                .storeUint(0, 8) // TIER_24H_SKIP
                .endCell();
            const link = tonLink(collAddr, toNano('5'), body.toBoc().toString('base64'));

            await callTg(token, 'sendMessage', {
                chat_id: chatId,
                text:
                    `⏱️ *24h Skip NFT — 5 TON*\n\n` +
                    `Activate once → covers 24 consecutive hourly epochs.\n` +
                    `Tradeable on any NFT marketplace.\n` +
                    `Your 5 TON → buys $TONkAS → LP locked forever 🔒`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [urlBtn('⏱️ Buy 24h Skip in Wallet', link)],
                        [btn('← Back', 'home')],
                    ],
                },
            });
            return;
        }

        // ── buy forever skip ──
        if (data === 'buy_forever') {
            await answerCbq(token, cbq.id);
            const collAddr = env.COLLECTION_ADDRESS || COLLECTION_ADDRESS;
            // OP_PAID_MINT = 0x80005301, tier = 1
            const body = beginCell()
                .storeUint(0x80005301, 32)
                .storeUint(0n, 64)
                .storeUint(1, 8) // TIER_FOREVER
                .endCell();
            const link = tonLink(collAddr, toNano('10'), body.toBoc().toString('base64'));

            await callTg(token, 'sendMessage', {
                chat_id: chatId,
                text:
                    `♾️ *Forever Skip NFT — 10 TON*\n\n` +
                    `Always active. Never press again. Always earning.\n` +
                    `Fully transferable — hold it, sell it, trade it.\n` +
                    `Your 10 TON → buys $TONkAS → LP locked forever 🔒`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [urlBtn('♾️ Buy Forever Skip in Wallet', link)],
                        [btn('← Back', 'home')],
                    ],
                },
            });
            return;
        }

        // ── stats ──
        if (data === 'stats') {
            await answerCbq(token, cbq.id);
            const wallet = await getWallet(env, uid);
            const lastMine = await env.DB.get(KV_LAST_MINE(uid));
            const { ok: canMineNow } = await canMine(env, uid);
            await editOrSendText(
                token, chatId, msgId,
                statsText(wallet, lastMine, canMineNow),
                backKeyboard(),
            );
            return;
        }

        // ── refer ──
        if (data === 'refer') {
            await answerCbq(token, cbq.id);
            // Fetch bot username
            const meResp = await callTg(token, 'getMe', {});
            const botUsername = meResp.result?.username ?? 'tonkasminerbot';
            await editOrSendText(
                token, chatId, msgId,
                referText(uid, botUsername),
                backKeyboard(),
            );
            return;
        }

        // ── anti-rug explainer ──
        if (data === 'antirug') {
            await answerCbq(token, cbq.id);
            await editOrSendText(
                token, chatId, msgId,
                antiRugText(),
                antiRugKeyboard(),
            );
            return;
        }

        // ── how it works ──
        if (data === 'howto') {
            await answerCbq(token, cbq.id);
            await editOrSendText(
                token, chatId, msgId,
                howtoText(),
                backKeyboard(),
            );
            return;
        }

        // ── connect wallet ──
        if (data === 'connect_wallet') {
            await answerCbq(token, cbq.id);
            await callTg(token, 'sendMessage', {
                chat_id: chatId,
                text:
                    `🔗 *Connect Your Wallet*\n\n` +
                    `Just paste your TON wallet address here (starts with EQ or UQ).\n\n` +
                    `Example:\n\`EQD...your...address...\`\n\n` +
                    `Your address is only used to sign claims and verify your slot ownership on-chain.`,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[btn('← Back', 'home')]] },
            });
            return;
        }

        await answerCbq(token, cbq.id);
    }
}

// ─── Entry point ──────────────────────────────────────────────
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // Debug: confirm which oracle identity this deployment is actually running with,
        // without exposing the seed itself. Added during the oracle-reconciliation pass --
        // see that incident's notes for why this mattered (a second, independently-seeded
        // oracle worker existed here, diverging from the canonical one).
        if (url.pathname === '/pubkey' && request.method === 'GET') {
            try {
                const seedLen = env.ORACLE_SEED ? env.ORACLE_SEED.length : -1;
                const seed = Buffer.from(env.ORACLE_SEED, 'hex');
                const kp = keyPairFromSeed(seed);
                return new Response(JSON.stringify({ pubkey: kp.publicKey.toString('hex'), seedHexLen: seedLen }), {
                    headers: { 'content-type': 'application/json' },
                });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
        }

        // Webhook registration helper
        if (url.pathname === '/register-webhook' && request.method === 'GET') {
            const webhookUrl = `${url.origin}/webhook`;
            const resp = await fetch(
                `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ url: webhookUrl }),
                }
            );
            const body = await resp.json();
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        }

        // Telegram webhook endpoint
        if (url.pathname === '/webhook' && request.method === 'POST') {
            try {
                const update = await request.json() as any;
                await handleUpdate(update, env);
            } catch (e: any) {
                console.error('Webhook error:', e.message);
            }
            return new Response('ok');
        }

        return new Response('TONkAS Game Bot', { status: 200 });
    },
};
