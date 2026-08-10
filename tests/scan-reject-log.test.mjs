// tests/scan-reject-log.test.mjs — the title-reject log.
//
// Network-free by construction. The live scanners were useless for verifying
// this: the ATS directories rate-limit hard after a few sweeps (190 of 240
// boards unreachable in one attempt), so a run can retrieve nothing at all and
// an empty log is indistinguishable from a broken recorder. These call the
// filter path directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTitleReject, flushTitleRejects, rejectBufferSize, buildTitleFilter, buildLocationFilter } from '../scan.mjs';
import { passesFilters } from '../scan-ats-full.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'co-rej-')), 'scan-rejects.tsv');
const rows = (f) => readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).slice(1).map((l) => l.split('\t'));

test('dedupes by title and counts repeats', () => {
  const f = tmp();
  recordTitleReject('Staff Product Designer', 'Airwallex', 'ashby');
  recordTitleReject('Staff Product Designer', 'Airwallex', 'ashby');
  recordTitleReject('Strategic Account Director', 'Cadence', 'workday');
  assert.equal(rejectBufferSize(), 2, 'buffer holds distinct titles, not occurrences');
  assert.equal(flushTitleRejects(f), 2);
  const r = rows(f);
  assert.equal(r.length, 2);
  assert.equal(r.find((x) => x[0] === 'Staff Product Designer')[4], '2', 'repeat counted');
  rmSync(f, { force: true });
});

test('the buffer is drained by a flush', () => {
  const f = tmp();
  recordTitleReject('A Title', 'Co', 'greenhouse');
  flushTitleRejects(f);
  assert.equal(rejectBufferSize(), 0, 'a second flush must not rewrite the same rejects');
  assert.equal(flushTitleRejects(f), 0, 'nothing buffered → no write, no empty file churn');
  rmSync(f, { force: true });
});

test('merges with an existing log instead of replacing it', () => {
  // A later scan over narrower sources must not erase vocabulary an earlier one
  // saw — the near-miss analysis reads the accumulated set.
  const f = tmp();
  recordTitleReject('Older Title', 'Co1', 'lever');
  flushTitleRejects(f);
  recordTitleReject('Newer Title', 'Co2', 'ashby');
  flushTitleRejects(f);
  const titles = rows(f).map((r) => r[0]);
  assert.ok(titles.includes('Older Title') && titles.includes('Newer Title'));
  rmSync(f, { force: true });
});

test('times_seen accumulates across separate scans', () => {
  const f = tmp();
  recordTitleReject('Recurring Title', 'Co', 'lever');
  flushTitleRejects(f);
  recordTitleReject('Recurring Title', 'Co', 'lever');
  flushTitleRejects(f);
  assert.equal(rows(f)[0][4], '2');
  rmSync(f, { force: true });
});

test('tabs and newlines in a scraped title cannot shear the columns', () => {
  const f = tmp();
  recordTitleReject('Bad\tTitle\nWith Breaks', 'Co', 'greenhouse');
  flushTitleRejects(f);
  const raw = readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim());
  assert.equal(raw.length, 2, 'one header plus exactly one data row');
  assert.equal(raw[1].split('\t').length, 5);
  rmSync(f, { force: true });
});

test('an unwritable path fails silently — a scan is never lost over its telemetry', () => {
  recordTitleReject('Some Title', 'Co', 'lever');
  assert.equal(flushTitleRejects('/proc/definitely/not/writable/x.tsv'), 0);
  assert.equal(rejectBufferSize(), 0, 'buffer still drained, so the next flush is clean');
});

test('passesFilters records the titles it rejects', () => {
  // The path the reverse scanner actually takes. Patching only the inline check
  // left this one silent, and rate limiting hid it.
  const f = tmp();
  const titleFilter = buildTitleFilter({ positive: ['Inference'], negative: ['Sales'] });
  const locationFilter = buildLocationFilter(null);
  const job = (title) => ({ title, company: 'Co', source: 'greenhouse', location: '', url: '' });

  assert.equal(passesFilters(job('Senior Inference Engineer'), { titleFilter, locationFilter, contentFilter: null }), true);
  assert.equal(passesFilters(job('Strategic Account Director'), { titleFilter, locationFilter, contentFilter: null }), false);
  assert.equal(passesFilters(job('Staff Product Designer'), { titleFilter, locationFilter, contentFilter: null }), false);

  assert.equal(rejectBufferSize(), 2, 'only the rejected titles are recorded');
  flushTitleRejects(f);
  const titles = rows(f).map((r) => r[0]);
  assert.ok(!titles.includes('Senior Inference Engineer'), 'an accepted title is not logged');
  rmSync(f, { force: true });
});

test('empty and whitespace titles are ignored', () => {
  recordTitleReject('', 'Co', 'lever');
  recordTitleReject('   ', 'Co', 'lever');
  assert.equal(rejectBufferSize(), 0);
});
