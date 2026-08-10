#!/usr/bin/env node

/**
 * filter-audit.mjs — what your title_filter is actually doing.
 *
 * Zero-LLM, read-only. The keyword layer decides the fate of ~78% of everything
 * scanned (measured: 8,289 found → 6,499 rejected on title alone) and reports
 * nothing about how. scan.mjs already computes which keywords matched a title —
 * matchedTitleKeywords() — but only to scope content_filter, and throws the
 * answer away 8,000 times per scan. This replays it over the offers that
 * survived, so the filter can be tuned from evidence instead of guesswork.
 *
 * Three questions, two of which it can answer today:
 *
 *   1. Which keywords earn their keep?  — replayed over scan-history.tsv
 *   2. Which generate noise?           — joined against evaluated scores
 *   3. What am I missing?              — needs rejected titles, which the
 *                                        scanner does not record. See --help.
 *
 * The metric that matters is `unique`, not `hits`: how many offers a keyword is
 * the ONLY one to catch. A keyword with 200 hits and 0 unique can be deleted
 * without losing a single posting; one with 3 hits and 3 unique is the only
 * reason those three were ever seen.
 *
 * Usage:
 *   node filter-audit.mjs
 *   node filter-audit.mjs --summary
 *   node filter-audit.mjs --self-test
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { matchedTitleKeywords } from './scan.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORTALS = join(ROOT, 'portals.yml');
const HISTORY = join(ROOT, 'data', 'scan-history.tsv');
const REPORTS = join(ROOT, 'reports');

/** scan-history.tsv rows. Positional by header — trailing columns are appended
 *  over time and older rows legitimately have fewer (see DATA_CONTRACT.md). */
export function readHistory(tsv) {
  const lines = tsv.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split('\t');
  const iUrl = head.indexOf('url');
  const iTitle = head.indexOf('title');
  const iCompany = head.indexOf('company');
  if (iTitle === -1) return [];
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    return { url: c[iUrl] ?? '', title: c[iTitle] ?? '', company: c[iCompany] ?? '' };
  }).filter((r) => r.title);
}

/** url → score, from the evaluation reports. Lets a keyword be judged on the
 *  quality of what it admits, not just the quantity. */
export function readScoresByUrl(reportTexts) {
  const map = new Map();
  for (const text of reportTexts) {
    const u = text.match(/\*\*URL:\*\*\s*<?([^\s>\n)]+)/);
    const s = text.match(/\*\*Score:\*\*\s*([0-9](?:\.[0-9])?)/);
    if (u && s) map.set(u[1].replace(/[)\s]+$/, ''), Number(s[1]));
  }
  return map;
}

export function audit(titleFilter, history, scoresByUrl) {
  const positives = Array.isArray(titleFilter?.positive) ? titleFilter.positive : [];
  const stats = new Map(positives.map((k) => [k, { keyword: k, hits: 0, unique: 0, scored: 0, scoreSum: 0, examples: [] }]));
  let unmatched = 0;

  for (const row of history) {
    const hit = matchedTitleKeywords(row.title, titleFilter);
    if (hit.length === 0) {
      // Present in history but matched nothing: the filter changed since this
      // row was recorded. Worth surfacing rather than silently dropping.
      unmatched++;
      continue;
    }
    const score = scoresByUrl.get(row.url);
    for (const k of hit) {
      const s = stats.get(k);
      if (!s) continue;
      s.hits++;
      if (hit.length === 1) s.unique++;
      if (typeof score === 'number') { s.scored++; s.scoreSum += score; }
      if (s.examples.length < 3) s.examples.push(row.title);
    }
  }

  const rows = [...stats.values()].map((s) => ({
    ...s,
    avgScore: s.scored ? Number((s.scoreSum / s.scored).toFixed(2)) : null,
  }));
  rows.sort((a, b) => b.unique - a.unique || b.hits - a.hits || a.keyword.localeCompare(b.keyword));

  return {
    offers: history.length,
    keywords: positives.length,
    unmatchedRows: unmatched,
    dead: rows.filter((r) => r.hits === 0).map((r) => r.keyword),
    // Carries its weight only through other keywords: deleting it loses nothing.
    redundant: rows.filter((r) => r.hits > 0 && r.unique === 0).map((r) => r.keyword),
    // Admits a lot, and what it admits scores badly. The cost is real: every one
    // of these is a candidate someone might pay to evaluate.
    noisy: rows.filter((r) => r.hits >= 5 && r.avgScore !== null && r.avgScore < 2.5),
    rows,
  };
}

// ── self-test ────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => (c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`)));

  const tf = { positive: ['Inference', 'Machine Learning', 'Performance', 'Quantization'] };
  const history = [
    { url: 'u1', title: 'Senior Inference Engineer', company: 'A' },
    { url: 'u2', title: 'Machine Learning Engineer, Inference', company: 'B' },
    { url: 'u3', title: 'High-Performance Databases Engineer', company: 'C' },
    { url: 'u4', title: 'Performance Engineer, Storage', company: 'D' },
    { url: 'u5', title: 'Staff Performance Engineer', company: 'E' },
    { url: 'u6', title: 'Performance Analyst', company: 'F' },
    { url: 'u7', title: 'Perf Engineer', company: 'G' }, // matches nothing
    { url: 'u8', title: 'Performance Tuning Engineer', company: 'H' },
  ];
  // Five Performance hits, all evaluated, mean exactly 1.5 — deliberately on the
  // >=5 hits / <2.5 average boundary the noisy rule uses.
  const scores = new Map([['u3', 1.5], ['u4', 1.8], ['u5', 2.0], ['u6', 1.2], ['u8', 1.0]]);
  const r = audit(tf, history, scores);

  ok(r.dead.includes('Quantization'), 'a keyword that matched nothing is reported dead');
  ok(!r.dead.includes('Inference'), 'a keyword with hits is not dead');
  ok(r.unmatchedRows === 1, 'rows matching no keyword are counted, not silently dropped');

  const inf = r.rows.find((x) => x.keyword === 'Inference');
  const ml = r.rows.find((x) => x.keyword === 'Machine Learning');
  ok(inf.hits === 2 && inf.unique === 1, 'unique counts only offers this keyword alone caught');
  ok(ml.unique === 0 && ml.hits === 1, 'a keyword riding on another contributes hits but no unique');
  ok(r.redundant.includes('Machine Learning'), 'zero-unique keyword flagged redundant');

  const perf = r.rows.find((x) => x.keyword === 'Performance');
  ok(perf.hits === 5 && perf.avgScore === 1.5, 'average score computed over evaluated offers only');
  ok(r.noisy.some((x) => x.keyword === 'Performance'), 'high-volume low-scoring keyword flagged noisy');
  ok(!r.noisy.some((x) => x.keyword === 'Inference'), 'unscored keyword is not called noisy');

  ok(r.rows[0].unique >= r.rows[r.rows.length - 1].unique, 'sorted by recall value, not raw hits');

  console.log(`\n${fail === 0 ? '🟢' : '🔴'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();
if (argv.includes('--help')) {
  console.log(`filter-audit.mjs — what your title_filter is actually doing

  node filter-audit.mjs             JSON
  node filter-audit.mjs --summary   human-readable

Answers "which keywords earn their keep" and "which generate noise" by
replaying the matcher over data/scan-history.tsv.

It cannot yet answer "what am I missing": that needs the titles the filter
REJECTED, and the scanner records only a count of them (scan-runs.tsv
filtered_title), never the titles. Adding a bounded reject log to scan.mjs
would close it — the near-miss set is then (rejected titles) ∩ (cv.md
vocabulary) − (current positives), derived rather than guessed.`);
  process.exit(0);
}

if (!existsSync(PORTALS)) { console.error('portals.yml not found.'); process.exit(1); }
const cfg = yaml.load(readFileSync(PORTALS, 'utf8')) || {};
const history = existsSync(HISTORY) ? readHistory(readFileSync(HISTORY, 'utf8')) : [];
const reportTexts = existsSync(REPORTS)
  ? readdirSync(REPORTS).filter((f) => f.endsWith('.md') && !f.includes('RESERVED')).map((f) => readFileSync(join(REPORTS, f), 'utf8'))
  : [];
const result = audit(cfg.title_filter, history, readScoresByUrl(reportTexts));

if (!argv.includes('--summary')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('TITLE FILTER AUDIT');
  console.log(`${result.keywords} keywords replayed over ${result.offers} admitted offers`);
  if (result.unmatchedRows) console.log(`${result.unmatchedRows} historical rows match no current keyword (filter changed since)`);
  console.log('');

  if (result.dead.length) {
    console.log(`  NEVER MATCHED (${result.dead.length}) — too narrow, misspelled, or the market does not use the word:`);
    console.log(`    ${result.dead.join(', ')}\n`);
  }
  if (result.noisy.length) {
    console.log('  NOISY — admits volume, and what it admits scores badly:');
    for (const r of result.noisy) {
      console.log(`    ${r.keyword}  ${r.hits} hits · ${r.unique} unique · avg ${r.avgScore}/5`);
      if (r.examples[0]) console.log(`      e.g. "${r.examples[0]}"`);
    }
    console.log('');
  }
  if (result.redundant.length) {
    console.log(`  REDUNDANT (${result.redundant.length}) — every match also caught by another keyword; deleting loses nothing:`);
    console.log(`    ${result.redundant.join(', ')}\n`);
  }

  const carrying = result.rows.filter((r) => r.unique > 0).slice(0, 12);
  console.log('  CARRYING THE SEARCH — offers only this keyword catches:');
  for (const r of carrying) {
    console.log(`    ${String(r.unique).padStart(4)} unique  ${String(r.hits).padStart(4)} hits  ${r.avgScore !== null ? `avg ${r.avgScore}` : '  —  '}  ${r.keyword}`);
  }
  console.log('\n  `unique` is the number to tune on. A keyword with hits but no unique can go;');
  console.log('  one with few hits and all of them unique is the only reason those were seen.');
  console.log('  Run --help for why "what am I missing" is not answered here yet.');
}
