#!/usr/bin/env node
/**
 * titles-derive.mjs — propose `title_filter.positive` from cv.md.
 *
 * The initialization step the repo does not have (issue #2751). Today a new
 * user is told `cp templates/portals.example.yml portals.yml` and gets the
 * template author's 37 keywords — measured against this checkout's CV, 6 of the
 * 37 overlap and the resulting filter rejects the candidate's own current job
 * title. cv.md is never consulted.
 *
 * Two layers, in this order:
 *
 *   MECHANICAL (always) — reads cv.md's Experience and Skills sections and
 *     emits candidates. No model, no network, byte-identical across runs.
 *     Also the only layer that proposes REMOVALS, because that is the operation
 *     which must give the same answer twice.
 *
 *   MODEL (only if an agent CLI is installed) — fills the two gaps the
 *     mechanical layer cannot: market synonyms the CV never spells
 *     ("Model Compression" for quantization work), and the axis/evidence/
 *     breadth notes modes/titles.md specifies. Skipped, loudly, when no CLI is
 *     present — never silently, since the fallback is worse than it looks.
 *
 * Writes NOTHING. Output is a proposal for a caller to diff and confirm, per
 * modes/titles.md's rule that portals.yml is never written without the user
 * seeing the exact diff first.
 *
 * Day zero — `--init` — is the case doctor.mjs used to answer with
 * `cp templates/portals.example.yml portals.yml`. It still starts there: the
 * template is copied verbatim, because everything in it except
 * `title_filter.positive` (companies, boards, location and negative filters)
 * has no derivation path and is a better starting point than nothing. Then:
 *
 *   - an agent CLI is installed  → both layers run and the template's keywords
 *     are REPLACED by the CV-derived set, with the same diff report --write
 *     prints. There is no history to regress against yet, so no recall gate.
 *   - no CLI (or --no-llm)       → the template's keywords are KEPT — the
 *     original onboarding flow, unchanged — and the mechanical candidates are
 *     printed as advice. Nothing mechanical-only is written: the user asked for
 *     "the author's flow when there is no AI", and a half-derived list with no
 *     synonyms and no drops is neither that nor a finished proposal.
 *
 * Usage:
 *   node titles-derive.mjs                # mechanical + model if available
 *   node titles-derive.mjs --no-llm       # mechanical only
 *   node titles-derive.mjs --json
 *   node titles-derive.mjs --cli codex
 *   node titles-derive.mjs --write        # replace title_filter.positive in portals.yml
 *   node titles-derive.mjs --init         # day zero: no portals.yml yet (see above)
 *   node titles-derive.mjs --help
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './lib/yaml-document.mjs';
import {
  deriveKeywords, readCv, unsupportedByCv, redundancyGroups,
  readTargetRoles, targetVocabulary, isOnTarget,
} from './lib/cv-keywords.mjs';
// The scanner's own matcher — a claim about what a keyword admits is checked
// against the code that will actually run, never taken on assertion.
import { buildTitleFilter } from './scan.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { replacePositiveBlock as replacePositiveBlockShared, scaffoldPortals, TEMPLATE_REL } from './lib/portals-blocks.mjs';

// User-layer files (cv.md, portals.yml, modes/_profile.md, data/) resolve under
// the data root; system-layer files (modes/titles-init.md, the template) ship
// with the code. DATA_CONTRACT — CAREER_OPS_ROOT may separate the two.
const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const argv = process.argv.slice(2);

const USAGE = `Usage:
  node titles-derive.mjs                # propose title_filter.positive from cv.md (mechanical + model if a CLI is installed)
  node titles-derive.mjs --no-llm       # mechanical layer only
  node titles-derive.mjs --json         # machine-readable proposal
  node titles-derive.mjs --cli <name>   # force one agent CLI (claude, codex, grok, gemini)
  node titles-derive.mjs --write        # replace title_filter.positive in an existing portals.yml
  node titles-derive.mjs --force        # with --write: accept a >25% recall loss against scan-history
  node titles-derive.mjs --init         # day zero: copy templates/portals.example.yml, then derive if a CLI is installed
  node titles-derive.mjs --help`;

const KNOWN_FLAGS = ['--json', '--no-llm', '--write', '--force', '--init', '--cli', '--help', '-h'];
validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: ['--cli'], requireOperand: true });
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }

const JSON_OUT = argv.includes('--json');
const NO_LLM = argv.includes('--no-llm');
const WRITE = argv.includes('--write');
const FORCE = argv.includes('--force');
const INIT = argv.includes('--init');
const CLI_ARG = argv.includes('--cli') ? argv[argv.indexOf('--cli') + 1] : null;
if (INIT && WRITE) die('--init and --write are different situations: --init creates portals.yml, --write updates one that exists.');

/** Headless invocations, mirroring web/src/lib/clis.ts. Order = detect order. */
const CLIS = [
  { id: 'claude', bin: 'claude', args: (p) => ['-p', p] },
  { id: 'codex', bin: 'codex', args: (p) => ['exec', p] },
  { id: 'grok', bin: 'grok', args: (p) => ['-p', p] },
  { id: 'gemini', bin: 'gemini', args: (p) => ['-p', p] },
];

function die(msg) {
  console.error(`titles-derive: ${msg}`);
  process.exit(1);
}

function read(rel) {
  const p = join(DATA_ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
function readSystem(rel) {
  const p = join(CODE_ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function which(bin) {
  return spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).status === 0;
}

function pickCli() {
  const wanted = CLI_ARG ? CLIS.filter((c) => c.id === CLI_ARG) : CLIS;
  if (CLI_ARG && !wanted.length) die(`unknown --cli "${CLI_ARG}" (known: ${CLIS.map((c) => c.id).join(', ')})`);
  return wanted.find((c) => which(c.bin)) ?? null;
}

// ── inputs ───────────────────────────────────────────────────────────────────

const cv = read('cv.md');
if (!cv) {
  die(
    'cv.md not found — there is no evidence to derive from.\n' +
    '  Create it in the project root (see doctor.mjs), then re-run.',
  );
}

// ── day zero (--init) ────────────────────────────────────────────────────────
//
// The template is copied whole, not assembled: its companies, boards, location
// and negative filters are the author's, but they are a working scanner, and
// nothing in the repo can derive them from a CV. Only the keyword block has a
// derivation path, and it is replaced further down — but only when a model ran.

const TEMPLATE = TEMPLATE_REL;
if (INIT) {
  if (existsSync(join(DATA_ROOT, 'portals.yml'))) {
    die('portals.yml already exists — --init is for a checkout that has none.\n' +
        '  To re-derive the keywords of an existing file, run with --write instead.');
  }
  try { scaffoldPortals(DATA_ROOT, CODE_ROOT); } catch (e) { die(e.message); }
  if (!JSON_OUT) console.error(`titles-derive: copied ${TEMPLATE} → portals.yml`);
}

const portalsRaw = read('portals.yml');
const portals = portalsRaw ? loadYaml(portalsRaw) : null;
const currentPositive = portals?.title_filter?.positive ?? [];

// ── mechanical layer ─────────────────────────────────────────────────────────

const sections = readCv(cv);
// Real posting titles, used ONLY to detect substring collisions (a keyword that
// matches inside other words). Bias in this corpus is irrelevant to that
// question — it changes which titles are present, not whether "system" contains
// "stem" — so the filter's own scan history is a fine source.
const corpusPath = join(DATA_ROOT, 'data', 'scan-history.tsv');
const corpus = existsSync(corpusPath)
  ? [...new Set(readFileSync(corpusPath, 'utf8').split('\n').slice(1).map((l) => l.split('\t')[3]).filter(Boolean))]
  : [];
const derived = deriveKeywords(cv, { corpus });
// NOT collapsed here, deliberately. Dropping a keyword that a shorter one
// already covers is behaviour-preserving, so it looked free — but the shorter
// form is the one that survives, and the shorter form is frequently the worse
// one (`Serving` over `Model Serving`, `Prompt` over `Prompt Engineering`).
// Keeping both is exactly equivalent to keeping the broad one, so collapsing
// buys nothing except a tidier list, at the price of silently choosing a side.
// The pairs are surfaced as decisions instead; see redundancy_groups.
const usable = derived.filter((d) => !d.generic);
const generic = derived.filter((d) => d.generic);
const unsupported = unsupportedByCv(currentPositive, derived);
// modes/_profile.md's target-roles table, used to MARK rather than to filter.
// Tried as a whitelist first and it rejected `Machine Learning`, `GPU`,
// `Prompt Engineering` and `Computer Vision` — that file writes "ML" and never
// mentions GPUs, so absence from it is not evidence of anything. As a flag it
// still carries the one thing cv.md cannot: which of the CV's five positions
// the user is actually hunting more of.
const targetVocab = targetVocabulary(readTargetRoles(read('modes/_profile.md') ?? ''));
for (const d of usable) d.onTarget = isOnTarget(d.keyword, targetVocab);
// Pairs where one keyword already covers another under substring matching.
// Surfaced as a decision rather than resolved: which side to keep goes both
// ways (`Machine Learning` beats `Machine Learning Engineer`; `Model Serving`
// beats `Serving`), and only the existence of the choice is mechanical.
const groups = redundancyGroups(usable.map((d) => d.keyword));

const result = {
  cv_sections_read: {
    experience_titles: sections.roles,
    domain_groups: sections.domain.map((g) => g.label || '(unlabelled)'),
    tool_groups_excluded: sections.tools.map((g) => g.label || '(unlabelled)'),
    skipped: sections.skippedSections,
  },
  mechanical: { candidates: usable, generic, redundancy_groups: groups },
  current_positive_count: currentPositive.length,
  unsupported_by_cv: unsupported,
  model: null,
};

// ── model layer (optional) ───────────────────────────────────────────────────

const cli = NO_LLM ? null : pickCli();

if (INIT && (NO_LLM || !cli)) {
  // The user's rule for day zero without a model: the author's original flow,
  // which is the template as shipped. Said explicitly, because the alternative
  // — a filter silently built from CV nouns with no synonyms and no drops —
  // would look finished and recall a fraction of the market.
  console.error(
    'titles-derive: ' + (NO_LLM ? '--no-llm' : 'no agent CLI on PATH') + ' — keeping the template\'s keywords ' +
    '(the original onboarding flow).\n' +
    '  The CV-derived candidates below are advice only; nothing beyond the template copy was written.\n' +
    '  When a CLI is available, `node titles-derive.mjs --write` replaces the keywords from cv.md.',
  );
} else if (!NO_LLM && !cli) {
  // Loud, not silent. A user who does not know this step was skipped will
  // assume the keyword list is complete when it is missing every synonym the CV
  // does not literally spell.
  console.error(
    'titles-derive: no agent CLI on PATH (' + CLIS.map((c) => c.bin).join(', ') + ') — ' +
    'mechanical layer only.\n' +
    '  Skipped: market synonyms the CV never writes, axis classification, and\n' +
    '  breadth warnings. The candidates below are still CV-derived and usable;\n' +
    '  they are just narrower than what a model would add.',
  );
}

if (cli) {
  // The instructions live in modes/titles-init.md, not in this file — same
  // arrangement as gemini-eval.mjs reading modes/oferta.md. A prompt in a mode
  // file is reviewable, diffable and editable by the user; a prompt in a
  // template literal is neither.
  const mode = readSystem('modes/titles-init.md');
  if (!mode) die('modes/titles-init.md not found — the model layer has no instructions. Re-run with --no-llm for the mechanical pass alone.');
  const profile = read('modes/_profile.md') ?? '';

  const PROMPT = `${mode}

---

# INPUT

## cv.md

${cv}

## modes/_profile.md (targeting narrative and deal-breakers — constrains what is on-target; NOT an evidence source)

${profile}

## CANDIDATES (already extracted mechanically — review, do not re-derive)

${JSON.stringify(usable.map((d) => d.keyword))}

## REDUNDANCY GROUPS (one broader keyword and the narrower ones it already covers)

${JSON.stringify(groups)}
`;

  if (!JSON_OUT) console.error(`titles-derive: mechanical layer done (${usable.length}); asking ${cli.id} for synonyms + drops…`);
  const run = spawnSync(cli.bin, cli.args(PROMPT), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  const out = `${run.stdout || ''}`;
  if (run.status !== 0) {
    // stdout too: these CLIs report auth and quota failures there, so a
    // stderr-only message is blank exactly when it matters.
    die(`${cli.id} exited ${run.status}\n${[run.stderr, out].filter(Boolean).join('\n').slice(0, 1500)}`);
  }
  if (/not logged in|please run \/login|not authenticated|invalid api[- ]?key/i.test(out)) {
    die(`${cli.id} is not authenticated:\n  ${out.trim().split('\n')[0]}`);
  }

  const json = extractJson(out);
  if (!json) {
    console.error(`titles-derive: ${cli.id} returned no JSON object — keeping the mechanical result only.`);
  } else {
    try {
      const parsed = JSON.parse(json);
      result.model = {
        cli: cli.id,
        persona: parsed.persona ?? '',
        rewrite: parsed.rewrite ?? [],
        add: parsed.add ?? [],
        drop: verifyDrops(parsed.drop ?? []),
        keep: parsed.keep ?? [],
      };
    } catch (e) {
      console.error(`titles-derive: could not parse ${cli.id}'s JSON (${e.message}) — keeping the mechanical result only.`);
    }
  }
}

/**
 * Check each proposed drop's stated false positives against the REAL matcher.
 *
 * Models are not reliable about mechanical facts, and the failure is confident
 * rather than hedged. Observed on this CV: claude proposed dropping `AI`
 * because it "matches inside 'Training', 'Retail', 'Domain', 'Maintain',
 * 'Chair', 'Captain'". None of those match — scan.mjs::compileKeyword
 * word-boundaries any keyword of 2–3 characters, precisely so short ones cannot
 * do that. Acting on the claim would have removed a correct keyword for a
 * reason that is false.
 *
 * So every named title is run through buildTitleFilter. A drop whose evidence
 * does not reproduce is kept and labelled, not silently honoured — and not
 * silently discarded either, since the conclusion may still be right for a
 * reason the model stated badly.
 *
 * @param {{keyword: string, why: string, false_positives?: string[]}[]} drops
 * @returns {({verified: boolean, confirmed: string[], refuted: string[]} & object)[]}
 */
function verifyDrops(drops) {
  return drops.map((d) => {
    const claimed = Array.isArray(d.false_positives) ? d.false_positives : [];
    if (!claimed.length) return { ...d, verified: null, confirmed: [], refuted: [] };
    const f = buildTitleFilter({ positive: [d.keyword], negative: [] });
    const confirmed = claimed.filter((t) => f(String(t)));
    const refuted = claimed.filter((t) => !f(String(t)));
    return { ...d, verified: confirmed.length > 0, confirmed, refuted };
  });
}

/** First balanced {...} in a response that may carry chatter around it. */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * Apply the model's edits to the mechanical candidates, in a fixed order, and
 * converge the redundancy groups.
 *
 * Order matters and is not arbitrary: rewrites first (so a later drop or group
 * decision names the keyword as it will exist), then additions, then drops,
 * then group convergence over the result. Doing this here rather than in the
 * caller's head is the point — the counts printed below and the YAML written by
 * --write must come from the same computation.
 *
 * A drop whose stated evidence was refuted is NOT applied. The conclusion may
 * still be right, but it was argued from something that is not true, and
 * silently honouring it is how a correct keyword gets deleted for a false
 * reason (see verifyDrops).
 *
 * @param {{keyword: string}[]} candidates
 * @param {object|null} model
 * @returns {string[]}
 */
function resolveKeywords(candidates, model) {
  let set = candidates.map((c) => c.keyword);
  if (!model) return [...new Set(set)];

  const rewrites = new Map((model.rewrite ?? []).map((r) => [r.from, r.to]));
  set = set.map((k) => rewrites.get(k) ?? k);
  set = [...set, ...(model.add ?? []).map((a) => a.keyword)].filter((k) => typeof k === 'string' && k.trim());

  const dropped = new Set((model.drop ?? []).filter((d) => d.verified !== false).map((d) => d.keyword));
  set = set.filter((k) => !dropped.has(k));

  for (const decision of model.keep ?? []) {
    const group = redundancyGroups(set).find((g) => g.broad === decision.group);
    if (!group) continue;
    const lose = [group.broad, ...group.covers].filter((k) => k !== decision.keep);
    set = set.filter((k) => !lose.includes(k));
  }
  return [...new Set(set)];
}

const resolved = resolveKeywords(usable, result.model);
result.resolved = resolved;
result.residual_redundancy = redundancyGroups(resolved);

/**
 * Would this filter still catch what the current one has been catching?
 *
 * data/scan-history.tsv is every posting a scan has admitted, so it is biased
 * BY the current keywords — useless for discovering gaps, and exactly right for
 * detecting a regression. A proposal that drops most of it is not a tighter
 * filter, it is a broken one, and the first version of this tool produced
 * precisely that: 23 keywords that recalled 135 of 541.
 */
function recallCheck(keywords) {
  const p = join(DATA_ROOT, 'data', 'scan-history.tsv');
  if (!existsSync(p)) return null;
  const titles = readFileSync(p, 'utf8').split('\n').slice(1).map((l) => l.split('\t')[3]).filter(Boolean);
  if (!titles.length) return null;
  const negative = portals?.title_filter?.negative ?? [];
  const before = titles.filter(buildTitleFilter({ positive: currentPositive, negative }));
  const fAfter = buildTitleFilter({ positive: keywords, negative });
  const lost = before.filter((t) => !fAfter(t));
  return { corpus: titles.length, before: before.length, after: titles.filter(fAfter).length, lost: [...new Set(lost)] };
}

result.recall = recallCheck(resolved);

// --init writes only when a model ran: a template copy plus mechanical nouns is
// not the "AI suggestions" the flag promises, and the template alone is the
// documented fallback for that case.
const INIT_WRITES = INIT && Boolean(result.model);
if (INIT) result.init = { scaffolded_from: TEMPLATE, keywords_written: INIT_WRITES };

// ── output ───────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  if (WRITE || INIT_WRITES) applyWrite({ quiet: true });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const s = result.cv_sections_read;
console.log(`\nRead cv.md — experience: ${s.experience_titles.length} titles · domain groups: ${s.domain_groups.join(', ') || 'none'}`);
if (s.tool_groups_excluded.length) console.log(`Excluded as tooling: ${s.tool_groups_excluded.join(', ')}`);
if (s.skipped.length) console.log(`Skipped sections: ${s.skipped.join(' · ')}`);

console.log(`\n── ${usable.length} candidates from cv.md ──`);
for (const d of usable) console.log(`  ${d.keyword.padEnd(28)} ${d.source.padEnd(13)} ← ${d.from}`);

if (generic.length) {
  console.log(`\n── ${generic.length} bare head nouns (in the CV, but not a filter alone) ──`);
  console.log(`  ${generic.map((d) => d.keyword).join(' · ')}`);
}

if (result.model) {
  const m = result.model;
  if (m.persona) console.log(`\n── how ${m.cli} reads this CV ──\n  ${m.persona.replace(/\n/g, '\n  ')}`);
  if (m.rewrite.length) {
    console.log(`\n── ${m.rewrite.length} rewritten to market form ──`);
    for (const x of m.rewrite) console.log(`  ${String(x.from).padEnd(28)} → ${String(x.to).padEnd(26)} ${x.why}`);
  }
  if (m.add.length) {
    console.log(`\n── ${m.add.length} added (the CV does not spell these) ──`);
    for (const x of m.add) console.log(`  ${String(x.keyword).padEnd(28)} [${x.axis}] ${x.why}`);
  }
  if (m.drop.length) {
    console.log(`\n── ${m.drop.length} dropped ──`);
    for (const x of m.drop) {
      console.log(`  ${String(x.keyword).padEnd(28)}${x.verified === false ? ' ⚠ evidence refuted' : ''} ${x.why}`);
      if (x.refuted?.length) console.log(`      these do NOT match ${x.keyword} in the real matcher: ${x.refuted.join(' · ')}`);
    }
  }
  if (m.keep.length) {
    console.log(`\n── ${m.keep.length} redundancy groups resolved ──`);
    for (const x of m.keep) console.log(`  keep ${String(x.keep).padEnd(26)} over the rest of "${x.group}" — ${x.why}`);
  }
} else if (groups.length) {
  console.log(`\n── ${groups.length} redundancy groups (no model ran; keeping both sides of a pair buys nothing) ──`);
  for (const g of groups.slice(0, 10)) console.log(`  ${g.broad.padEnd(24)} already covers ${g.covers.join(' · ')}`);
  if (groups.length > 10) console.log(`  … and ${groups.length - 10} more`);
}

if (unsupported.length) {
  console.log(`\n── ${unsupported.length} of the current ${result.current_positive_count} positives have no cv.md support ──`);
  console.log(`  ${unsupported.join(' · ')}`);
}

console.log(`\n── resolved: ${resolved.length} keywords ──`);
console.log(`  ${resolved.join(' · ')}`);
if (result.residual_redundancy.length) {
  console.log(`  ⚠ ${result.residual_redundancy.length} redundancy groups still unresolved`);
}

if (result.recall) {
  const r = result.recall;
  const pct = r.before ? Math.round((100 * (r.before - r.lost.length)) / r.before) : 100;
  console.log(`\n── regression check against ${r.corpus} postings already seen ──`);
  console.log(`  current filter caught ${r.before} · this proposal catches ${r.after} · keeps ${pct}% of them`);
  if (r.lost.length) {
    console.log(`  ${r.lost.length} would no longer match, e.g.:`);
    for (const t of r.lost.slice(0, 8)) console.log(`      ${t}`);
  }
}

if (!WRITE && !INIT) console.log('\nNothing written. portals.yml is unchanged. Re-run with --write to apply.');
if (INIT && !INIT_WRITES) console.log(`\nportals.yml created from ${TEMPLATE}; its title_filter.positive is the template's.`);

// ── write ────────────────────────────────────────────────────────────────────

/** Textual replacement of title_filter.positive — see lib/portals-blocks.mjs. */
export function replacePositiveBlock(src, keywords) {
  return replacePositiveBlockShared(src, keywords);
}

if (WRITE || INIT_WRITES) applyWrite({ quiet: false });

function applyWrite({ quiet }) {
  if (!portalsRaw) die('portals.yml not found — nothing to update. Scaffold it first (node titles-derive.mjs --init).');
  if (!resolved.length) die('the derivation produced no keywords — refusing to write an empty filter, which matches every posting.');
  const r = result.recall;
  // The recall gate compares against what the CURRENT keywords admitted. On
  // --init the current keywords are the template's, and losing what a
  // stranger's filter caught is the point, not a regression.
  if (WRITE && !FORCE && r && r.before > 0 && r.lost.length / r.before > 0.25) {
    die(
      `refusing to write: this proposal loses ${r.lost.length} of ${r.before} postings the current filter catches ` +
      `(${Math.round((100 * r.lost.length) / r.before)}%).\n` +
      '  A filter is a cheap gate before an expensive evaluation; a large drop is a broken gate, not a tighter one.\n' +
      '  Review the report above, then re-run with --force if the loss is intended.',
    );
  }
  const next = replacePositiveBlock(portalsRaw, resolved);
  writeFileSync(join(DATA_ROOT, 'portals.yml'), next, 'utf8');
  if (!quiet) console.log(`\nWrote ${resolved.length} keywords to portals.yml title_filter.positive. Everything else is ${INIT ? 'the template' : 'unchanged'}.`);
}
