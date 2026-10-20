#!/usr/bin/env node
/**
 * titles-suggest.mjs — AI-proposed `title_filter` keywords from cv.md, verified
 * against real scan history before anything is written.
 *
 * The third way to get a keyword list, beside the two the repo already has:
 *
 *   templates/portals.example.yml  — the author's market; what a user gets with
 *                                    no agent (the original onboarding flow)
 *   modes/titles.md                — widens a list that already exists
 *   THIS                           — an agent reads cv.md (nothing else) and
 *                                    proposes three buckets: `roles` to search
 *                                    for now, `candidates` the user may promote,
 *                                    `exclude` to keep the noise out
 *
 * The model is not trusted on assertion. Every keyword is replayed with the
 * scanner's own matcher over data/scan-history.tsv (admitted) and
 * its skipped_title rows (rejected) — see lib/keyword-replay.mjs — and the
 * report shows, per keyword, how many titles it admits, how many only it
 * admits, and how many were previously rejected. Determinism comes from that
 * replay, not from the generator: two runs may propose differently, but the
 * same proposal always scores the same.
 *
 * Usage:
 *   node titles-suggest.mjs                     # ask the first agent CLI on PATH, replay, report
 *   node titles-suggest.mjs --cli grok          # a specific CLI (claude, codex, grok, gemini)
 *   node titles-suggest.mjs --hint "..."        # one line of targeting passed to the model
 *   node titles-suggest.mjs --prompt            # print the exact prompt and exit — answer it in an
 *                                               # agent session, save the JSON, then:
 *   node titles-suggest.mjs --from answer.json  # replay + report a proposal produced elsewhere
 *   node titles-suggest.mjs --json              # machine-readable report (web, tests)
 *   node titles-suggest.mjs --write             # replace title_filter.positive with `roles`,
 *                                               # append `exclude` to title_filter.negative
 *   node titles-suggest.mjs --force             # with --write: accept losing >50% of what the
 *                                               # current filter admits
 *   node titles-suggest.mjs --init              # day zero: copy the template first; write only if
 *                                               # a proposal was obtained, else keep the template
 *   node titles-suggest.mjs --help
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { pickCli, askAgent } from './lib/agent-run.mjs';
import { loadCorpus, replayProposal, keywordStats } from './lib/keyword-replay.mjs';
import { replaceListBlock, appendToListBlock, scaffoldPortals, TEMPLATE_REL } from './lib/portals-blocks.mjs';

// Two roots, deliberately (DATA_CONTRACT): user-layer files — cv.md, portals.yml,
// data/ — live under the data root, which CAREER_OPS_ROOT may point away from
// the checkout; system-layer files — this mode's instructions, the template —
// ship with the code.
const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const argv = process.argv.slice(2);

const USAGE = `Usage:
  node titles-suggest.mjs                     # ask the first agent CLI on PATH, replay, report
  node titles-suggest.mjs --cli <name>        # claude, codex, grok, gemini
  node titles-suggest.mjs --hint "<line>"     # one line of targeting passed to the model
  node titles-suggest.mjs --prompt            # print the exact prompt and exit
  node titles-suggest.mjs --from <file.json>  # replay + report a proposal produced elsewhere
  node titles-suggest.mjs --json              # machine-readable report
  node titles-suggest.mjs --write             # replace title_filter.positive; append exclude to negative
  node titles-suggest.mjs --force             # with --write: accept a >50% loss of currently admitted postings
  node titles-suggest.mjs --init              # day zero: copy the template, then write if a proposal was obtained
  node titles-suggest.mjs --help`;

const KNOWN_FLAGS = ['--cli', '--hint', '--prompt', '--from', '--json', '--write', '--force', '--init', '--help', '-h'];
validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: ['--cli', '--hint', '--from'], requireOperand: true });
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }

const flagValue = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const CLI_ARG = flagValue('--cli');
const HINT = flagValue('--hint');
const FROM = flagValue('--from');
const PRINT_PROMPT = argv.includes('--prompt');
const JSON_OUT = argv.includes('--json');
const WRITE = argv.includes('--write');
const FORCE = argv.includes('--force');
const INIT = argv.includes('--init');
if (INIT && WRITE) die('--init and --write are different situations: --init creates portals.yml, --write updates one that exists.');

function die(msg) { console.error(`titles-suggest: ${msg}`); process.exit(1); }
function readUser(rel) { const p = join(DATA_ROOT, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; }
function readSystem(rel) { const p = join(CODE_ROOT, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; }
const log = (...a) => { if (!JSON_OUT) console.error(...a); };

// ── inputs ───────────────────────────────────────────────────────────────────

const cv = readUser('cv.md');
if (!cv) die('cv.md not found — there is no evidence to derive from. Create it in the project root, then re-run.');

if (INIT) {
  if (existsSync(join(DATA_ROOT, 'portals.yml'))) {
    die('portals.yml already exists — --init is for a checkout that has none. Use --write to update it.');
  }
  try { scaffoldPortals(DATA_ROOT, CODE_ROOT); } catch (e) { die(e.message); }
  log(`titles-suggest: copied ${TEMPLATE_REL} → portals.yml`);
}

const portalsRaw = readUser('portals.yml');
const portals = portalsRaw ? yaml.load(portalsRaw) : null;
const baseline = portals?.title_filter
  ? { positive: portals.title_filter.positive ?? [], negative: portals.title_filter.negative ?? [] }
  : null;

// ── prompt ───────────────────────────────────────────────────────────────────

const mode = readSystem('modes/titles-suggest.md');
if (!mode) die('modes/titles-suggest.md not found — the model has no instructions.');

const PROMPT = `${mode}

---

# INPUT

## cv.md

${cv}
${HINT ? `\n## Targeting line from the user\n\n${HINT}\n` : ''}`;

if (PRINT_PROMPT) { process.stdout.write(PROMPT); process.exit(0); }

// ── proposal ─────────────────────────────────────────────────────────────────

let raw = null;
let source = null;
if (FROM) {
  const text = existsSync(FROM) ? readFileSync(FROM, 'utf8') : null;
  if (!text) die(`--from ${FROM}: file not found`);
  try { raw = JSON.parse(text); } catch (e) { die(`--from ${FROM}: not JSON (${e.message})`); }
  source = `file:${FROM}`;
} else {
  let cli = null;
  try { cli = pickCli(CLI_ARG); } catch (e) { die(e.message); }
  if (!cli) {
    if (INIT) {
      log('titles-suggest: no agent CLI on PATH — keeping the template\'s keywords (the original onboarding flow).\n' +
          '  When an agent is available: `node titles-suggest.mjs --write`, or `--prompt` → answer → `--from`.');
    } else {
      die('no agent CLI on PATH (claude, codex, grok, gemini).\n' +
          '  Either install one, or run `--prompt`, answer it in your agent session, and pass the JSON with `--from`.');
    }
  } else {
    log(`titles-suggest: asking ${cli.id}…`);
    try { raw = askAgent(cli, PROMPT); } catch (e) { die(e.message); }
    source = cli.id;
  }
}

// ── normalize ────────────────────────────────────────────────────────────────

/** Coerce a bucket to [{keyword, why}], trimmed, de-duplicated case-insensitively. */
function bucket(v) {
  const arr = Array.isArray(v) ? v : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const keyword = String(typeof item === 'string' ? item : item?.keyword ?? '').trim();
    const why = String(typeof item === 'string' ? '' : item?.why ?? '').trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push({ keyword, why });
  }
  return out;
}

let proposal = null;
if (raw) {
  const roles = bucket(raw.roles);
  const candidates = bucket(raw.candidates);
  const exclude = bucket(raw.exclude);
  // A 2–3 character positive is whole-word matched by the scanner, so it is not
  // the substring disaster it looks like — but bare `AI` still admits AI Tutor,
  // AI Strategist, AI Success Manager, while `LLM` admits seven inference
  // postings and nothing else. The difference is measurable: replay the token
  // alone and ask whether it would mostly admit titles the current filter has
  // been REJECTING. If so, it is a decision for the user, not a default — demote
  // it to candidates with the reason attached. With no scan history to ask,
  // demote: a fresh checkout has no evidence either way, and broad is the
  // expensive mistake (every admitted posting is a paid evaluation).
  const corpusForShort = loadCorpus(DATA_ROOT);
  const negForShort = [...new Set([...(baseline?.negative ?? []), ...exclude.map((e) => e.keyword)])];
  const short = roles.filter((r) => {
    if (r.keyword.length > 3) return false;
    const s = keywordStats(r.keyword, negForShort, corpusForShort);
    return s.hits === 0 || s.rejectedHits > s.admittedHits;
  });
  const shortSet = new Set(short.map((s) => s.keyword));
  const kept = roles.filter((r) => !shortSet.has(r.keyword));
  for (const s of short) {
    if (!candidates.some((c) => c.keyword.toLowerCase() === s.keyword.toLowerCase())) {
      candidates.unshift({ keyword: s.keyword, why: `(short token — whole-word matched, and it would mostly admit titles the current filter rejects) ${s.why}`.trim() });
    }
  }
  const roleSet = new Set(kept.map((r) => r.keyword.toLowerCase()));
  proposal = {
    persona: String(raw.persona ?? '').trim(),
    roles: kept,
    candidates: candidates.filter((c) => !roleSet.has(c.keyword.toLowerCase())),
    exclude,
    demoted: short.map((s) => s.keyword),
  };
}

// ── replay ───────────────────────────────────────────────────────────────────

const corpus = proposal ? loadCorpus(DATA_ROOT) : { admitted: [], rejected: [] };
let replay = null;
if (proposal) {
  const negative = [...new Set([...(baseline?.negative ?? []), ...proposal.exclude.map((e) => e.keyword)])];
  replay = replayProposal({ positive: proposal.roles.map((r) => r.keyword), negative }, corpus, baseline);
  const byKeyword = new Map(replay.perKeyword.map((p) => [p.keyword, p]));
  for (const r of proposal.roles) Object.assign(r, byKeyword.get(r.keyword) ?? {});
  for (const c of proposal.candidates) Object.assign(c, keywordStats(c.keyword, negative, corpus));
  for (const e of proposal.exclude) {
    const s = keywordStats(e.keyword, [], corpus);
    Object.assign(e, { vetoes: s.hits, vetoesAdmitted: s.admittedHits, examples: s.examples });
  }
}

const result = {
  source,
  cv_chars: cv.length,
  hint: HINT ?? null,
  proposal,
  replay: replay && {
    corpus: replay.corpus,
    keeps: replay.keeps,
    gains: replay.gains,
    zeroHit: replay.zeroHit,
    regression: replay.regression && {
      before: replay.regression.before,
      after: replay.regression.after,
      lost: replay.regression.lost.length,
      lostSample: [...new Set(replay.regression.lost)].slice(0, 12),
      gained: replay.regression.gained.length,
      gainedSample: [...new Set(replay.regression.gained)].slice(0, 12),
    },
  },
  init: INIT ? { scaffolded_from: TEMPLATE_REL, keywords_written: Boolean(proposal) } : undefined,
};

// ── write ────────────────────────────────────────────────────────────────────

function applyWrite() {
  if (!portalsRaw) die('portals.yml not found — nothing to update. Scaffold it first (node titles-suggest.mjs --init).');
  if (!proposal?.roles.length) die('the proposal has no roles — refusing to write an empty filter, which matches every posting.');
  const r = replay?.regression;
  // A tighter filter loses noise on purpose; a broken one loses everything. The
  // line between them is a judgement the report supports and a flag records.
  if (WRITE && !FORCE && r && r.before > 0 && r.lost.length / r.before > 0.5) {
    die(`refusing to write: this proposal drops ${r.lost.length} of the ${r.before} postings the current filter admits ` +
        `(${Math.round((100 * r.lost.length) / r.before)}%).\n` +
        '  Review the lost titles in the report; re-run with --force if that loss is intended.');
  }
  const stamp = new Date().toISOString().slice(0, 10);
  let text = replaceListBlock(portalsRaw, 'positive', proposal.roles.map((k) => k.keyword), [
    `Proposed from cv.md by titles-suggest.mjs (${source}, ${stamp}); every keyword replayed against scan history.`,
    'Re-run after a CV change. Hand edits here are kept until the next run proposes a diff over them.',
  ]);
  const { text: withNeg, added } = appendToListBlock(text, 'negative', proposal.exclude.map((k) => k.keyword), [
    `Added by titles-suggest.mjs (${source}, ${stamp}) — title families that share words with the roles above.`,
  ]);
  writeFileSync(join(DATA_ROOT, 'portals.yml'), withNeg, 'utf8');
  result.written = { roles: proposal.roles.length, exclude_added: added.length };
  log(`\nWrote ${proposal.roles.length} roles to title_filter.positive and ${added.length} new negatives to title_filter.negative. Everything else is ${INIT ? 'the template' : 'unchanged'}.`);
}

if (WRITE || (INIT && proposal)) applyWrite();

// ── output ───────────────────────────────────────────────────────────────────

if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

if (!proposal) {
  if (INIT) console.log(`\nportals.yml created from ${TEMPLATE_REL}; its title_filter.positive is the template's.`);
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n── how ${source} reads this CV ──\n  ${proposal.persona.replace(/\n/g, '\n  ')}`);
console.log(`\n── replayed over ${replay.corpus.admitted} admitted + ${replay.corpus.rejected} rejected titles ──`);

console.log(`\n── roles (${proposal.roles.length}) — search for these now ──`);
console.log(`  ${pad('keyword', 30)} ${pad('hits', 6)} ${pad('only', 6)} ${pad('prev-rejected', 14)} why`);
for (const r of proposal.roles) console.log(`  ${pad(r.keyword, 30)} ${pad(r.hits ?? 0, 6)} ${pad(r.unique ?? 0, 6)} ${pad(r.rejectedHits ?? 0, 14)} ${r.why}`);
if (replay.zeroHit.length) console.log(`  ⚠ never matched a seen title: ${replay.zeroHit.join(' · ')}`);
if (proposal.demoted.length) console.log(`  ↓ demoted to candidates (2–3 letter tokens): ${proposal.demoted.join(' · ')}`);

console.log(`\n── candidates (${proposal.candidates.length}) — promote the ones you want ──`);
console.log(`  ${pad('keyword', 30)} ${pad('hits', 6)} ${pad('prev-rejected', 14)} why`);
for (const c of proposal.candidates) console.log(`  ${pad(c.keyword, 30)} ${pad(c.hits ?? 0, 6)} ${pad(c.rejectedHits ?? 0, 14)} ${c.why}`);

console.log(`\n── exclude (${proposal.exclude.length}) — negatives ──`);
console.log(`  ${pad('keyword', 30)} ${pad('vetoes', 8)} e.g.`);
for (const e of proposal.exclude) console.log(`  ${pad(e.keyword, 30)} ${pad(e.vetoes ?? 0, 8)} ${(e.examples ?? []).slice(0, 2).join(' · ')}`);

const r = replay.regression;
if (r) {
  const pct = r.before ? Math.round((100 * (r.before - r.lost.length)) / r.before) : 100;
  console.log(`\n── against the current filter ──`);
  console.log(`  current admits ${r.before} of the seen titles · this proposal admits ${r.after} of those (${pct}%) and ${replay.gains} previously rejected`);
  if (r.lost.length) console.log(`  no longer admitted, e.g.: ${[...new Set(r.lost)].slice(0, 8).join(' · ')}`);
  if (r.gained.length) console.log(`  newly admitted, e.g.:     ${[...new Set(r.gained)].slice(0, 8).join(' · ')}`);
}

if (!WRITE && !INIT) console.log('\nNothing written. portals.yml is unchanged. Re-run with --write to apply, or --json for the web.');
if (INIT && result.init?.keywords_written) console.log(`\nportals.yml created from ${TEMPLATE_REL} with the proposed keywords.`);
