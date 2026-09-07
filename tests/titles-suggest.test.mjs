// tests/titles-suggest.test.mjs — the AI-proposed keyword path, everything
// except the model call.
//
// The model half needs a CLI on PATH and is not exercised. What is pinned is
// the contract around it: the prompt is the mode file plus cv.md and nothing
// else; a proposal fed in with --from is normalized, replayed with the
// scanner's own matcher, and reported with numbers that come from the corpus;
// --write replaces one block and appends to another while every other byte of
// portals.yml survives; the loss gate refuses a broken filter; --init keeps the
// template when there is nothing to write.

import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';

console.log('\ntitles-suggest — AI keyword proposal, verified');

const ok = (msg, cond) => (cond ? pass(msg) : fail(msg));

const CV = [
  '# Jane Smith', '', '## Experience', '',
  '### Machine Learning Engineer — Acme', '*2023 — Present*', '',
  '- Optimize LLM inference with quantization on edge silicon.', '',
  '## Skills', '', '**ML Systems:** LLM Inference Optimization, Model Quantization', '',
].join('\n');

const PORTALS = [
  '# my portals — the comment above the filter must survive',
  'scan_history:',
  '  recheck_after_days: 30',
  '',
  'title_filter:',
  '  positive:',
  '    # old hand-written list',
  '    - "Design Engineer"',
  '    - "Inference"',
  '    - "Architecture"',
  '  negative:',
  '    - "Sales"',
  '    - "Recruiter"',
  '',
  '  seniority_boost:',
  '    - "Senior"',
  '',
  'tracked_companies:',
  '  # Acme was probed live 2026-01-01 — keep this comment',
  '  - name: Acme',
  '    careers_url: https://boards.greenhouse.io/acme',
  '    enabled: true',
  '',
].join('\n');

const ADMITTED = ['LLM Inference Engineer', 'Senior Inference Engineer', 'Mechanical Design Engineer', 'Thermal Design Engineer', 'Solutions Architecture Manager', 'Analog Design Engineer', 'Inference Performance Architect'];
const REJECTED = ['ML Systems Engineer', 'AI Tutor - Czech', 'Kernel Engineer', 'Sales Engineer', 'Compiler Engineer'];

function checkout({ portals = PORTALS, corpus = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'titles-suggest-'));
  for (const d of ['templates', 'modes', 'data']) mkdirSync(join(dir, d), { recursive: true });
  cpSync(join(ROOT, 'templates', 'portals.example.yml'), join(dir, 'templates', 'portals.example.yml'));
  cpSync(join(ROOT, 'modes', 'titles-suggest.md'), join(dir, 'modes', 'titles-suggest.md'));
  writeFileSync(join(dir, 'cv.md'), CV);
  if (portals) writeFileSync(join(dir, 'portals.yml'), portals);
  if (corpus) {
    writeFileSync(join(dir, 'data', 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n' + ADMITTED.map((t, i) => `https://x/${i}\t2026-01-01\tp\t${t}\tAcme\tadded`).join('\n') + '\n');
    writeFileSync(join(dir, 'data', 'scan-rejects.tsv'), 'title\tcompany\tsource\tlast_seen\ttimes_seen\n' + REJECTED.map((t) => `${t}\tAcme\tp\t2026-01-01\t1`).join('\n') + '\n');
  }
  return dir;
}

const PROPOSAL = {
  persona: 'An inference engineer.',
  roles: [
    { keyword: 'Inference', why: 'cv' },
    { keyword: 'ML Systems', why: 'cv' },
    { keyword: 'Kernel', why: 'cv' },
    { keyword: 'AI', why: 'too short and it would only admit rejected titles — should be demoted' },
    { keyword: 'LLM', why: 'short but every hit is an admitted posting — stays a role' },
    { keyword: 'inference', why: 'duplicate, different case' },
  ],
  candidates: [{ keyword: 'Compiler', why: 'adjacent' }],
  exclude: [{ keyword: 'Tutor', why: 'noise' }, { keyword: 'Sales', why: 'already present' }],
};

function run(cwd, ...args) {
  return spawnSync(NODE, [join(ROOT, 'titles-suggest.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', CAREER_OPS_ROOT: cwd }, // no CLI on PATH; user layer = the temp checkout
  });
}
const writeProposal = (dir, p = PROPOSAL) => { const f = join(dir, 'proposal.json'); writeFileSync(f, JSON.stringify(p)); return f; };

// ── the prompt is cv.md + the mode file, nothing else ────────────────────────
{
  const dir = checkout();
  const r = run(dir, '--prompt');
  ok('--prompt exits 0 without a CLI', r.status === 0);
  ok('prompt contains the mode file', r.stdout.includes('# Mode: titles-suggest'));
  ok('prompt contains cv.md verbatim', r.stdout.includes('Optimize LLM inference with quantization on edge silicon.'));
  ok('prompt does NOT contain portals.yml or a profile', !r.stdout.includes('tracked_companies') && !r.stdout.includes('_profile'));
  const h = run(dir, '--prompt', '--hint', 'IC only, no DV');
  ok('--hint is appended as the targeting line', h.stdout.includes('## Targeting line from the user') && h.stdout.includes('IC only, no DV'));
  rmSync(dir, { recursive: true, force: true });
}

// ── --from: normalize + replay + report ──────────────────────────────────────
{
  const dir = checkout();
  const r = run(dir, '--from', writeProposal(dir), '--json');
  ok('--from --json exits 0', r.status === 0);
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* fall through */ }
  ok('JSON parses', Boolean(j));
  const roles = j?.proposal?.roles?.map((x) => x.keyword) ?? [];
  ok('roles de-duplicated case-insensitively', roles.filter((k) => k.toLowerCase() === 'inference').length === 1);
  ok('a 2–3 letter role that would mostly admit rejected titles is demoted to candidates', !roles.includes('AI') && j?.proposal?.candidates?.some((c) => c.keyword === 'AI'));
  ok('a 2–3 letter role whose hits are admitted postings stays a role', roles.includes('LLM'));
  ok('demotion is recorded, and only for the broad one', JSON.stringify(j?.proposal?.demoted) === JSON.stringify(['AI']));
  const inf = j?.proposal?.roles?.find((x) => x.keyword === 'Inference');
  ok('Inference: 3 admitted hits in the fixture corpus', inf?.admittedHits === 3);
  ok('ML Systems: 1 previously-rejected hit', j?.proposal?.roles?.find((x) => x.keyword === 'ML Systems')?.rejectedHits === 1);
  const tutor = j?.proposal?.exclude?.find((x) => x.keyword === 'Tutor');
  ok('exclude keywords report what they would veto', tutor?.vetoes === 1);
  ok('candidate keywords get their own stats', j?.proposal?.candidates?.find((c) => c.keyword === 'Compiler')?.rejectedHits === 1);
  const reg = j?.replay?.regression;
  ok('regression compares against the current filter', reg?.before === 7 && reg?.after === 3 && reg?.lost === 4);
  ok('gains counted from the rejected corpus', j?.replay?.gains === 2); // ML Systems Engineer, Kernel Engineer (AI Tutor vetoed, Compiler is a candidate)
  ok('nothing written without --write', readFileSync(join(dir, 'portals.yml'), 'utf8') === PORTALS);

  const human = run(dir, '--from', writeProposal(dir));
  ok('human report lists the three buckets', /── roles \(4\)/.test(human.stdout) && /── candidates \(2\)/.test(human.stdout) && /── exclude \(2\)/.test(human.stdout));
  ok('human report warns about the demotion', /demoted to candidates.*AI/.test(human.stdout));
  rmSync(dir, { recursive: true, force: true });
}

// ── --write: replace positive, append negative, preserve everything else ─────
{
  const dir = checkout();
  // the fixture proposal loses 4 of 6 (67%) → the gate fires
  const gated = run(dir, '--from', writeProposal(dir), '--write');
  ok('--write refuses a >50% loss without --force', gated.status === 1 && /refusing to write/.test(gated.stderr));
  ok('…and leaves portals.yml untouched', readFileSync(join(dir, 'portals.yml'), 'utf8') === PORTALS);

  const forced = run(dir, '--from', writeProposal(dir), '--write', '--force');
  ok('--write --force exits 0', forced.status === 0);
  const text = readFileSync(join(dir, 'portals.yml'), 'utf8');
  const doc = yaml.load(text);
  ok('title_filter.positive is exactly the roles', JSON.stringify(doc.title_filter.positive) === JSON.stringify(['Inference', 'ML Systems', 'Kernel', 'LLM']));
  ok('title_filter.negative keeps the old entries and gains the new one once', JSON.stringify(doc.title_filter.negative) === JSON.stringify(['Sales', 'Recruiter', 'Tutor']));
  ok('the old positive comment is gone with the old list', !text.includes('old hand-written list'));
  ok('the header comment survives', text.startsWith('# my portals — the comment above the filter must survive'));
  ok('tracked_companies and its comment survive byte-for-byte', text.includes('  # Acme was probed live 2026-01-01 — keep this comment\n  - name: Acme\n    careers_url: https://boards.greenhouse.io/acme\n    enabled: true'));
  ok('seniority_boost survives', JSON.stringify(doc.title_filter.seniority_boost) === JSON.stringify(['Senior']));
  ok('the provenance comment names the source', /Proposed from cv\.md by titles-suggest\.mjs \(file:/.test(text));
  rmSync(dir, { recursive: true, force: true });
}

// ── --init ───────────────────────────────────────────────────────────────────
{
  const dir = checkout({ portals: null, corpus: false });
  const r = run(dir, '--init');
  ok('--init without a CLI or --from exits 0', r.status === 0);
  const tpl = readFileSync(join(dir, 'templates', 'portals.example.yml'), 'utf8');
  ok('…and portals.yml is the template, byte for byte', readFileSync(join(dir, 'portals.yml'), 'utf8') === tpl);
  ok('…and says so', /keeping the template/.test(r.stderr) && /title_filter\.positive is the template/.test(r.stdout));
  const again = run(dir, '--init');
  ok('a second --init refuses', again.status === 1 && /already exists/.test(again.stderr));
  rmSync(dir, { recursive: true, force: true });

  const dir2 = checkout({ portals: null, corpus: false });
  const w = run(dir2, '--init', '--from', writeProposal(dir2), '--json');
  ok('--init --from writes the proposal into the fresh template', w.status === 0);
  const doc = yaml.load(readFileSync(join(dir2, 'portals.yml'), 'utf8'));
  ok('…positive is the roles (no corpus on day zero → both short tokens demoted)', JSON.stringify(doc.title_filter.positive) === JSON.stringify(['Inference', 'ML Systems', 'Kernel']));
  ok('…the template negatives are kept and Tutor appended', doc.title_filter.negative.includes('Junior') && doc.title_filter.negative.includes('Tutor'));
  ok('…tracked_companies came from the template', Array.isArray(doc.tracked_companies) && doc.tracked_companies.length > 50);
  let j = null; try { j = JSON.parse(w.stdout); } catch { /* fall through */ }
  ok('…JSON records the init verdict', j?.init?.keywords_written === true && j?.written?.roles === 3);
  ok('…no loss gate on day zero (nothing to regress against)', j?.replay?.regression === null || j?.replay?.regression?.before === 0);
  rmSync(dir2, { recursive: true, force: true });
}

// ── guards ───────────────────────────────────────────────────────────────────
{
  const dir = checkout();
  ok('--init with --write is rejected', run(dir, '--init', '--write').status === 1);
  ok('no CLI and no --from is a loud failure that names --prompt', /--prompt/.test(run(dir).stderr));
  ok('--from with a missing file fails', run(dir, '--from', join(dir, 'nope.json')).status === 1);
  ok('an unknown flag is rejected', /unrecognized flag/.test(run(dir, '--bogus').stderr));
  const noCv = checkout(); rmSync(join(noCv, 'cv.md'));
  ok('no cv.md is a loud failure', /cv\.md not found/.test(run(noCv, '--prompt').stderr));
  rmSync(dir, { recursive: true, force: true }); rmSync(noCv, { recursive: true, force: true });
}
