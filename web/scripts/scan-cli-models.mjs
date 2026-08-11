#!/usr/bin/env node

/**
 * scan-cli-models.mjs — refresh the model list the Config picker offers.
 *
 * Re-runnable by design. Every CLI exposes its models differently and the
 * lists move (a vendor ships a new tier, you log into a different account), so
 * this is a command you re-run rather than a table anyone maintains by hand.
 *
 * Writes .career-ops-web/cli-models.json next to the other web runtime state.
 * The Config page reads that file; it never shells out on page load, because
 * `grok models` takes seconds and a settings page should not.
 *
 * Usage:
 *   node web/scripts/scan-cli-models.mjs            # scan and write the cache
 *   node web/scripts/scan-cli-models.mjs --print    # scan, print, write nothing
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { discoverModels } from '../src/lib/cli-models.mjs';
import { findBin } from '../src/lib/clis-bin.mjs';

const ROOT = process.env.CAREER_OPS_ROOT
  ? resolve(process.env.CAREER_OPS_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_PATH = join(ROOT, '.career-ops-web', 'cli-models.json');

const io = {
  readFile: (p) => readFileSync(p, 'utf8'),
  // A CLI that hangs waiting for a terminal must not hang the scan: `codex
  // models` does exactly that, which is why it is read from its cache file
  // instead — but the timeout protects whatever a future CLI does.
  runCommand: (bin, args) =>
    execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }),
  findBin,
  home: homedir(),
};

const results = discoverModels(io);
const doc = { scannedAt: new Date().toISOString(), clis: results };

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`CLI MODELS → ${CACHE_PATH}\n`);
  for (const [id, r] of Object.entries(results)) {
    if (r.error) {
      console.log(`  ${id.padEnd(8)} —  ${r.error}   (${r.source})`);
    } else if (r.models.length === 0) {
      console.log(`  ${id.padEnd(8)} —  source readable but listed nothing   (${r.source})`);
    } else {
      // One option is not a choice: the picker hides rather than offering a
      // dropdown you cannot change. Say so here so the absence isn't a mystery.
      const note = r.models.length === 1 ? '  → only one, picker stays hidden' : '';
      console.log(`  ${id.padEnd(8)} ${String(r.models.length).padStart(2)}  ${r.models.join(', ')}${note}`);
    }
  }
}
