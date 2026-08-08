tolk 1.4.2

// The LP Locker — the permanent anti-rug sink. Accepts any jetton (LP tokens from either
// DEX) and any TON sent to it; releases nothing, ever. There is no withdraw function and
// no upgrade path anywhere in this file — that's not a permission that could be revoked
// later, the exit is structurally absent. See docs/architecture.md's Router section
// ("LP token routing") and the "Why it's legitimate" section of docs/tokenomics.md.
//
// This file deliberately contains no `match`, no outgoing `createMessage`/.send() call,
// and no storage worth reading back — accepting an incoming message is enough to credit
// whatever jetton wallet or TON balance just paid it. That is the entire contract.
// The previous version of this file collapsed Router (swap + add-liquidity) logic in here
// too; that's been split back out per docs/architecture.md's build order (Router is built
// last, against real STON.fi/DeDust code, not scaffolded early) — see
// docs/reference/mock-dex-kit.tolk for that exploratory design instead.

fun onInternalMessage(in: InMessage) {
}

get fun isLpLocker(): int {
    return -1; // fixed marker so tooling/explorers can identify this contract by convention
}
