import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { IStorage } from '@tonconnect/sdk';

// TonConnect needs somewhere to persist bridge-session state (client id, session keys)
// across the async gap between generating a connect link and the wallet's reply landing
// on the SSE bridge — and, since this bot is meant to be reusable for every future
// mainnet action (not just this one deploy), across bot restarts too. One JSON file per
// Telegram chat, since each admin conversation gets its own TonConnect session.
export class FileStorage implements IStorage {
    private path: string;
    private cache: Record<string, string>;

    constructor(chatId: number | string, dir = __dirname + '/.sessions') {
        if (!existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
        this.path = `${dir}/${chatId}.json`;
        this.cache = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
    }

    private persist() {
        writeFileSync(this.path, JSON.stringify(this.cache, null, 2));
    }

    async setItem(key: string, value: string): Promise<void> {
        this.cache[key] = value;
        this.persist();
    }

    async getItem(key: string): Promise<string | null> {
        return this.cache[key] ?? null;
    }

    async removeItem(key: string): Promise<void> {
        delete this.cache[key];
        this.persist();
    }
}
