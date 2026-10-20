#!/usr/bin/env node
/**
 * answer-bank.mjs — the candidate's standing answers to recurring application
 * questions, kept across applications.
 *
 * Every ATS asks the same screening questions in slightly different words:
 * "Do you have the right to work in the country you are applying to?",
 * "Are you legally authorized to work in the United States?", "Will you now or
 * in the future require sponsorship?". The `apply` mode already refuses to
 * invent answers to these (they are the candidate's facts, not the CV's), so
 * today every new form asks the candidate again. This file is the memory that
 * makes it a question asked ONCE: the first time a question has no source, the
 * agent asks, records the answer here with the candidate's wording, and every
 * later form that asks the same thing — in any phrasing — is answered from it.
 *
 * `data/answer-bank.json` is USER LAYER (DATA_CONTRACT): never auto-updated,
 * never read by the scanner, gitignored under data/*. Facts only — a legal
 * consent (arbitration, AI-usage policy) may carry the candidate's standing
 * preference but is flagged `confirm_each_time` and is always surfaced, never
 * silently filled.
 *
 * Usage:
 *   node answer-bank.mjs lookup "<question text>"            # best match as JSON ({hit:false} when none)
 *   node answer-bank.mjs match --file fields.json            # batch: [{id,label,options?}] → per-field matches
 *   node answer-bank.mjs add --question "…" --answer "…" [--alias "…"]... [--source "user-stated 2026-09-06"]
 *                            [--confirm-each-time] [--scope company:Acme] [--note "…"]
 *   node answer-bank.mjs add --question "…" --pending        # record a question the candidate still has to answer
 *   node answer-bank.mjs list [--json]
 *   node answer-bank.mjs seed                                 # derive the profile-backed entries from config/profile.yml
 *   node answer-bank.mjs --self-test
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCareerOpsRoot, getProfilePath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadYaml } from './lib/yaml-document.mjs';

const DATA_ROOT = getCareerOpsRoot();
const BANK_PATH = join(DATA_ROOT, 'data', 'answer-bank.json');
const PROFILE_PATH = getProfilePath();

// ── matching ─────────────────────────────────────────────────────────────────
//
// Two signals, combined. Token overlap catches rewordings of one sentence;
// intent classes catch the cases where the wording shares almost nothing but
// the question is the same ("right to work" vs "legally authorized"). Both are
// deliberately conservative: a wrong hit on a screening question is worse than
// asking the candidate again.

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'for', 'you', 'your', 'are', 'do', 'is', 'will', 'or', 'and', 'this', 'that', 'we', 'be', 'have', 'has', 'any', 'please', 'with', 'on', 'at', 'as', 'if', 'it', 'which', 'what', 'would', 'now', 'future', 'country', 'role', 'position', 'job', 'applying', 'apply', 'us', 'our']);

export function normalize(q) {
  return String(q ?? '').toLowerCase().replace(/[*?!.:;,()\[\]"'’“”/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
export function tokens(q) {
  return new Set(normalize(q).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Intent classes: the question families ATS forms reuse. Order matters only
 *  for reporting; a question may belong to several. */
export const INTENTS = [
  ['sponsorship', /\b(sponsor|sponsorship|visa)\b/i],
  ['work_authorization', /\b(authori[sz]ed|authori[sz]ation|right to work|legally (able|permitted|allowed) to work|work permit|eligib(le|ility) to work)\b/i],
  ['relocation', /\b(relocat|willing to move|open to moving)\b/i],
  ['in_office', /\b(in[- ]person|on[- ]site|onsite|in the office|hybrid|remote)\b/i],
  ['start_date', /\b(start date|earliest.*start|available to start|when can you start|availability|notice period)\b/i],
  ['salary', /\b(salary|compensation|pay expectation|desired pay|expected (salary|compensation)|comp expectation|OTE)\b/i],
  ['interviewed_before', /\b(?:(?:interview|appl)\w*\b.*\b(?:before|previously|in the past)|(?:previously|before|in the past)\b.*\b(?:interview|appl)\w*)\b/i],
  ['pronunciation', /\b(pronounce|pronunciation)\b/i],
  ['address', /\b(address|where are you (currently )?located|current location|city.*state)\b/i],
  ['linkedin', /\blinkedin\b/i],
  ['github', /\bgithub\b/i],
  ['website', /\b(website|portfolio)\b/i],
  ['publications', /\b(publications?|google scholar)\b/i],
  ['source', /\b(how did you hear|where did you hear|referr(al|ed))\b/i],
  ['deadlines', /\b(deadline|timeline consideration)\b/i],
  ['current_company', /\b(current (company|employer)|present employer)\b/i],
  ['arbitration', /\barbitrat/i],
  ['ai_policy', /\b(ai policy|ai usage|use of ai|ai partnership)\b/i],
  ['clearance', /\b(security clearance|clearance)\b/i],
  ['citizenship', /\b(citizen|permanent resident|green card|nationality)\b/i],
  ['demographic', /\b(gender|ethnicity|race|veteran|disabilit|self[- ]identif|pronouns)\b/i],
];
export function intentsOf(q) {
  const s = String(q ?? '');
  return INTENTS.filter(([, re]) => re.test(s)).map(([k]) => k);
}

/**
 * Score one bank entry against a question. Returns 0..1.
 * Exact normalized match or alias match → 1. Otherwise the better of token
 * overlap (question + aliases) and intent agreement, with intent alone capped
 * below the auto-fill threshold unless the entry declares `intent_match: true`.
 */
export function score(entry, question) {
  const nq = normalize(question);
  const texts = [entry.question, ...(entry.aliases ?? [])];
  if (texts.some((t) => normalize(t) === nq)) return 1;
  const tq = tokens(question);
  let best = 0;
  for (const t of texts) best = Math.max(best, jaccard(tokens(t), tq));
  const qi = new Set(intentsOf(question));
  const ei = new Set(entry.intents ?? intentsOf(entry.question));
  const shared = [...qi].filter((i) => ei.has(i));
  const intentScore = qi.size && ei.size ? shared.length / Math.max(qi.size, ei.size) : 0;
  // Intent agreement is strong evidence only when the entry opted in (screening
  // families where wording varies wildly) — otherwise it is a tie-breaker.
  const intentWeight = entry.intent_match ? 0.85 : 0.5;
  return Math.max(best, intentScore * intentWeight);
}

export const AUTO_THRESHOLD = 0.6;   // ≥ → answer from the bank
export const SUGGEST_THRESHOLD = 0.35; // ≥ → show as a suggestion, still ask

export function lookup(bank, question, { scopeCompany = null } = {}) {
  let best = null;
  for (const e of bank.entries ?? []) {
    if (e.scope && e.scope !== 'global') {
      const co = String(e.scope).replace(/^company:/, '').toLowerCase();
      if (!scopeCompany || co !== String(scopeCompany).toLowerCase()) continue;
    }
    const s = score(e, question);
    if (!best || s > best.score) best = { score: s, entry: e };
  }
  if (!best || best.score < SUGGEST_THRESHOLD) return { hit: false, question, intents: intentsOf(question) };
  const e = best.entry;
  const level = best.score >= AUTO_THRESHOLD ? 'auto' : 'suggest';
  return {
    hit: true, level, score: Number(best.score.toFixed(3)), question, intents: intentsOf(question),
    id: e.id, answer: e.answer ?? null, status: e.status ?? (e.answer == null ? 'needs-user' : 'answered'),
    confirm_each_time: Boolean(e.confirm_each_time), source: e.source ?? null, note: e.note ?? null,
  };
}

// ── storage ──────────────────────────────────────────────────────────────────

export function loadBank(path = BANK_PATH) {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const b = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(b.entries)) b.entries = [];
  return b;
}
export function saveBank(bank, path = BANK_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(bank, null, 2) + '\n', 'utf8');
}
export function slugId(q) {
  return normalize(q).split(' ').filter((w) => !STOP.has(w)).slice(0, 6).join('-') || 'q';
}

/** Add or update. Same normalized question (or alias) → update in place; a
 *  pending entry answered later keeps its id and aliases. */
export function upsert(bank, { question, answer = null, aliases = [], source = null, confirm_each_time = false, scope = 'global', note = null, pending = false, intent_match = null }) {
  const nq = normalize(question);
  let e = (bank.entries ?? []).find((x) => [x.question, ...(x.aliases ?? [])].some((t) => normalize(t) === nq));
  const today = new Date().toISOString().slice(0, 10);
  if (!e) {
    e = { id: slugId(question), question, aliases: [], intents: intentsOf(question), answer: null, status: 'needs-user', scope, source: null, confirm_each_time: false, note: null, created: today, updated: today };
    // keep ids unique
    let base = e.id, n = 2;
    while (bank.entries.some((x) => x.id === e.id)) e.id = `${base}-${n++}`;
    bank.entries.push(e);
  }
  for (const a of aliases) if (a && !e.aliases.some((x) => normalize(x) === normalize(a)) && normalize(a) !== normalize(e.question)) e.aliases.push(a);
  if (!pending) {
    if (answer != null) { e.answer = answer; e.status = 'answered'; }
    if (source) e.source = source;
  } else if (e.answer == null) {
    e.status = 'needs-user';
  }
  if (confirm_each_time) e.confirm_each_time = true;
  if (scope) e.scope = scope;
  if (note) e.note = note;
  if (intent_match != null) e.intent_match = Boolean(intent_match);
  e.updated = today;
  return e;
}

/** Entries that follow from config/profile.yml — derived, so `source` names the
 *  key and the candidate can see why the answer is what it is. */
export function seedFromProfile(profile) {
  const c = profile?.candidate ?? {}, loc = profile?.location ?? {}, comp = profile?.compensation ?? {}, cl = profile?.cover_letter ?? {};
  const out = [];
  if (loc.needs_sponsorship != null) {
    out.push({ question: 'Will you now or in the future require employment visa sponsorship to work in the country in which the job is located?', aliases: ['Do you require visa sponsorship?', 'Will you now or in the future require sponsorship for employment visa status?', 'Do you now or will you in the future require sponsorship to work in the United States?'], answer: loc.needs_sponsorship ? 'Yes' : 'No', source: 'config/profile.yml location.needs_sponsorship', intent_match: true, note: 'Lawful screening question; answer truthfully. The profile records the need for sponsorship, not the current authorization status.' });
  }
  if (cl.notice_period_days) out.push({ question: 'When is the earliest you would want to start working with us?', aliases: ['What is your earliest start date?', 'When are you available to start?', 'What is your notice period?'], answer: `About ${cl.notice_period_days} days from offer`, source: 'config/profile.yml cover_letter.notice_period_days', intent_match: true });
  if (comp.location_flexibility) out.push({ question: 'Are you open to working in-person in one of our offices 25% of the time?', aliases: ['Are you open to a hybrid schedule?', 'Are you willing to work on-site?'], answer: /on-site|hybrid/i.test(comp.location_flexibility) ? `Yes — ${comp.location_flexibility}` : comp.location_flexibility, source: 'config/profile.yml compensation.location_flexibility', intent_match: true });
  if (c.location) out.push({ question: 'Are you open to relocation for this role?', aliases: ['Are you willing to relocate?', 'Would you relocate for this position?'], answer: `Based in ${c.location}; no relocation needed for Bay Area roles — otherwise: ask me`, source: 'config/profile.yml candidate.location', intent_match: true, confirm_each_time: true, note: 'Depends on the role location; confirm per form.' });
  if (c.linkedin) out.push({ question: 'LinkedIn Profile', aliases: ['LinkedIn URL', 'LinkedIn'], answer: c.linkedin, source: 'config/profile.yml candidate.linkedin', intent_match: true });
  if (c.portfolio_url) out.push({ question: 'Publications (e.g. Google Scholar) URL', aliases: ['Google Scholar', 'Publications URL', 'Portfolio'], answer: c.portfolio_url, source: 'config/profile.yml candidate.portfolio_url', intent_match: true });
  out.push({ question: 'GitHub URL', aliases: ['GitHub Profile', 'GitHub'], answer: c.github ? c.github : '(leave blank)', source: 'config/profile.yml candidate.github', intent_match: true });
  if (comp.minimum) out.push({ question: 'What is your expected salary / compensation expectation?', aliases: ['Salary expectations', 'Desired compensation', 'What are your salary requirements?'], answer: `Base at or above ${comp.minimum}; open to discussing the full package against the role's market rate`, source: 'config/profile.yml compensation.minimum', intent_match: true, confirm_each_time: true, note: 'Give a number only when the form requires one; prefer the range language.' });
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function selfTest() {
  let fails = 0;
  const ok = (m, c) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fails++; };
  const bank = { version: 1, entries: [] };
  upsert(bank, { question: 'Do you have the right to work in the country you are applying to?', answer: 'Yes', source: 'user-stated 2026-09-06', intent_match: true });
  upsert(bank, { question: 'Will you now or in the future require employment visa sponsorship?', aliases: ['Do you require visa sponsorship?'], answer: 'Yes', intent_match: true });
  upsert(bank, { question: 'How do you pronounce your name?', pending: true });
  ok('exact wording → auto', lookup(bank, 'Do you have the right to work in the country you are applying to?').level === 'auto');
  ok('alias wording → auto', lookup(bank, 'Do you require visa sponsorship?').level === 'auto');
  const r = lookup(bank, 'Are you legally authorized to work in the United States?');
  ok('intent rewording of right-to-work → auto (intent_match entry)', r.hit && r.level === 'auto' && r.id.startsWith('right-work'));
  const s = lookup(bank, 'Will you require sponsorship for employment visa status now or in the future?');
  ok('sponsorship rewording → auto, and NOT the right-to-work entry', s.hit && s.level === 'auto' && /sponsorship/.test(s.id));
  ok('pending entry reports needs-user', lookup(bank, 'How do you pronounce your name?').status === 'needs-user');
  ok('unrelated question → no hit', lookup(bank, 'Describe a project you are proud of').hit === false);
  ok('demographic question never matches a work-auth entry', lookup(bank, 'What is your gender identity?').hit === false);
  const before = bank.entries.length;
  upsert(bank, { question: 'How do you pronounce your name?', answer: 'WEN-jiang; goes by JJ', source: 'user-stated' });
  ok('answering a pending question updates in place', bank.entries.length === before && lookup(bank, 'How do you pronounce your name?').status === 'answered');
  const seeded = seedFromProfile({ candidate: { location: 'San Jose, CA', linkedin: 'linkedin.com/in/x' }, location: { needs_sponsorship: true }, compensation: { minimum: '$180K', location_flexibility: 'Bay Area on-site or hybrid' }, cover_letter: { notice_period_days: 30 } });
  ok('seed derives sponsorship/start/in-office/relocation/linkedin/github/salary from profile', seeded.length === 7 && seeded[0].answer === 'Yes');
  ok('company-scoped entry is invisible to other companies', (() => { const b = { entries: [{ id: 'x', question: 'Have you ever interviewed at Anthropic before?', answer: 'No', scope: 'company:Anthropic', intents: ['interviewed_before'] }] }; return lookup(b, 'Have you ever interviewed at Anthropic before?', { scopeCompany: 'CoreWeave' }).hit === false && lookup(b, 'Have you ever interviewed at Anthropic before?', { scopeCompany: 'Anthropic' }).level === 'auto'; })());
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
}

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const flags = (f) => argv.map((a, i) => (a === f ? argv[i + 1] : null)).filter(Boolean);
const cmd = argv[0];

/** The Usage block of this file's header comment. */
function usage() {
  return readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('\n').filter((l) => /Usage|node answer-bank/.test(l)).map((l) => l.replace(/^ \* ?/, '')).join('\n');
}

if (isMainModule(import.meta.url)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); process.exit(0); }
  if (argv.includes('--self-test')) selfTest();
  else if (cmd === 'lookup') {
    const q = argv[1]; if (!q) { console.error('usage: node answer-bank.mjs lookup "<question>"'); process.exit(1); }
    console.log(JSON.stringify(lookup(loadBank(), q, { scopeCompany: flag('--company') }), null, 2));
  } else if (cmd === 'match') {
    const f = flag('--file'); if (!f) { console.error('usage: node answer-bank.mjs match --file fields.json [--company X]'); process.exit(1); }
    const fields = JSON.parse(readFileSync(f, 'utf8'));
    const bank = loadBank();
    // Field id stays `id` (the caller's handle); the bank entry's id moves to `entry`.
    const out = fields.map((fld) => { const { id: entry, question, ...r } = lookup(bank, fld.label, { scopeCompany: flag('--company') }); return { id: fld.id, label: fld.label, entry: entry ?? null, ...r }; });
    console.log(JSON.stringify({ auto: out.filter((x) => x.hit && x.level === 'auto' && x.status === 'answered' && !x.confirm_each_time), confirm: out.filter((x) => x.hit && (x.confirm_each_time || x.level === 'suggest' || x.status !== 'answered')), unknown: out.filter((x) => !x.hit) }, null, 2));
  } else if (cmd === 'add') {
    const question = flag('--question'); if (!question) { console.error('usage: node answer-bank.mjs add --question "…" (--answer "…" | --pending) [...]'); process.exit(1); }
    const bank = loadBank();
    const e = upsert(bank, { question, answer: flag('--answer'), aliases: flags('--alias'), source: flag('--source') || (flag('--answer') ? `user-stated ${new Date().toISOString().slice(0, 10)}` : null), confirm_each_time: argv.includes('--confirm-each-time'), scope: flag('--scope') || 'global', note: flag('--note'), pending: argv.includes('--pending'), intent_match: argv.includes('--intent-match') ? true : null });
    saveBank(bank); console.log(JSON.stringify(e, null, 2));
  } else if (cmd === 'seed') {
    const profile = existsSync(PROFILE_PATH) ? loadYaml(readFileSync(PROFILE_PATH, 'utf8')) : null;
    if (!profile) { console.error(`config/profile.yml not found at ${PROFILE_PATH}`); process.exit(1); }
    const bank = loadBank(); let n = 0;
    for (const s of seedFromProfile(profile)) { upsert(bank, s); n++; }
    saveBank(bank); console.log(`seeded ${n} profile-backed entries → ${BANK_PATH} (${bank.entries.length} total)`);
  } else if (cmd === 'list') {
    const bank = loadBank();
    if (argv.includes('--json')) console.log(JSON.stringify(bank, null, 2));
    else for (const e of bank.entries) console.log(`${(e.status === 'answered' ? '✅' : '❓').padEnd(2)} ${e.id.padEnd(34)} ${String(e.answer ?? '(needs your answer)').slice(0, 60).padEnd(62)} ${e.confirm_each_time ? '[confirm each time] ' : ''}${e.scope !== 'global' ? `[${e.scope}] ` : ''}← ${e.source ?? '—'}`);
  } else {
    console.log(usage());
  }
}
