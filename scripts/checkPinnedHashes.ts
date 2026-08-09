import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Recompiles every contract with a pinned hash and fails loudly on any mismatch. A rebuild
// producing a different hash than what's pinned means a shared file (constants.tolk,
// common.tolk, stdlib) changed underneath a contract whose own source didn't move -- which
// silently shifts its deploy address. See pinned-hashes.json's header for the incident that
// motivated this: LiquidityLocker's documented mainnet address didn't match what its
// current source actually compiles to, discovered only by chance before a real deploy.
//
// Run standalone: npx tsx scripts/checkPinnedHashes.ts

const ROOT = path.join(__dirname, '..');
const pins: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'pinned-hashes.json'), 'utf8'));

let failed = false;

for (const [name, expected] of Object.entries(pins)) {
    if (name.startsWith('_')) continue;

    execSync(`npx blueprint build ${name}`, { cwd: ROOT, stdio: 'pipe' });
    const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${name}.compiled.json`), 'utf8'));
    const actual = artifact.hash as string;

    if (actual !== expected) {
        failed = true;
        console.error(`MISMATCH: ${name}`);
        console.error(`  pinned:  ${expected}`);
        console.error(`  actual:  ${actual}`);
        console.error(`  A shared file this contract depends on has changed. If this is`);
        console.error(`  expected, update pinned-hashes.json deliberately -- and re-verify`);
        console.error(`  any address anywhere that assumes the old hash.`);
    } else {
        console.log(`OK: ${name}`);
    }
}

if (failed) {
    console.error('\nOne or more contracts compiled to a different hash than pinned.');
    process.exit(1);
}

console.log('\nAll pinned hashes match.');
