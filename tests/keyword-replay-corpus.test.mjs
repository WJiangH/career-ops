// tests/keyword-replay-corpus.test.mjs — loadCorpus splits scan-history.tsv on
// the title filter's verdict, and keeps the rejected titles the fork's earlier
// reject log wrote to data/scan-rejects.tsv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCorpus } from '../lib/keyword-replay.mjs';

test('skipped_title rows are rejected, everything else admitted, old reject log merged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keyword-replay-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'scan-history.tsv'), [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
      'https://x/1\t2026-10-01\tgh\tInference Engineer\tA\tadded',
      'https://x/2\t2026-10-01\tgh\tSales Director\tB\tskipped_title',
      'https://x/3\t2026-10-01\tgh\tML Engineer\tC\tskipped_location',
      'https://x/4\t2026-06-19\tPlatform Engineer', // pre-v1.18 three-cell row
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data', 'scan-rejects.tsv'), 'title\tcompany\tsource\tlast_seen\ttimes_seen\nAccount Executive\tD\tp\t2026-09-01\t2\nSales Director\tB\tp\t2026-09-01\t1\n');
    const { admitted, rejected } = loadCorpus(dir);
    assert.deepEqual(admitted, ['Inference Engineer', 'ML Engineer', 'Platform Engineer']);
    assert.deepEqual(rejected, ['Sales Director', 'Account Executive']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout with no history yields an empty corpus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keyword-replay-'));
  try {
    assert.deepEqual(loadCorpus(dir), { admitted: [], rejected: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
