// tests/answer-bank.test.mjs — the standing-answer memory behind apply's
// "ask once" rule. The matcher's in-memory contract lives in --self-test; this
// file pins the CLI surface against a temp data root: seed from a profile,
// record a pending question, answer it, and match a form.
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\nanswer-bank — ask once, answer everywhere');
const ok = (msg, cond) => (cond ? pass(msg) : fail(msg));

const dir = mkdtempSync(join(tmpdir(), 'answer-bank-'));
mkdirSync(join(dir, 'config'), { recursive: true }); mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'config', 'profile.yml'), [
  'candidate:', '  location: "San Jose, CA"', '  linkedin: "linkedin.com/in/jane"', '  portfolio_url: "https://scholar.google.com/x"', '  github: ""',
  'location:', '  needs_sponsorship: true',
  'compensation:', '  minimum: "$180K"', '  location_flexibility: "Bay Area on-site or hybrid"',
  'cover_letter:', '  notice_period_days: 30', ''].join('\n'));
const run = (...args) => spawnSync(NODE, [join(ROOT, 'answer-bank.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: dir } });

const st = run('--self-test');
ok('--self-test passes', st.status === 0 && /all passed/.test(st.stdout));

const seed = run('seed');
ok('seed writes data/answer-bank.json from the profile', seed.status === 0 && readFileSync(join(dir, 'data', 'answer-bank.json'), 'utf8').includes('needs_sponsorship'));

const sp = JSON.parse(run('lookup', 'Will you now or in the future require sponsorship for employment visa status?').stdout);
ok('a reworded sponsorship question is answered from the seeded entry', sp.hit && sp.level === 'auto' && sp.answer === 'Yes');

const pend = run('add', '--question', 'Do you have the right to work in the country you are applying to?', '--pending');
ok('--pending records a question without an answer', pend.status === 0 && JSON.parse(pend.stdout).status === 'needs-user');
const lk = JSON.parse(run('lookup', 'Are you legally authorized to work in the United States?').stdout);
ok('…and a rewording of it reports needs-user (not a guess)', lk.hit && lk.status === 'needs-user' && lk.answer === null);

const ans = run('add', '--question', 'Do you have the right to work in the country you are applying to?', '--answer', 'Yes', '--intent-match', '--source', 'user-stated 2026-09-06');
ok('answering the pending question keeps one entry', ans.status === 0 && JSON.parse(readFileSync(join(dir, 'data', 'answer-bank.json'), 'utf8')).entries.filter((e) => /right-work/.test(e.id)).length === 1);

const scoped = run('add', '--question', 'Have you ever interviewed at Anthropic before?', '--answer', 'No', '--scope', 'company:Anthropic');
ok('company-scoped entry saved', scoped.status === 0);

const fields = join(dir, 'fields.json');
writeFileSync(fields, JSON.stringify([
  { id: 'f1', label: 'Are you legally authorized to work in the United States?' },
  { id: 'f2', label: 'Do you require visa sponsorship?' },
  { id: 'f3', label: 'When is the earliest you would want to start working with us?' },
  { id: 'f4', label: 'Are you open to relocation for this role?' },
  { id: 'f5', label: 'Have you ever interviewed at Anthropic before?' },
  { id: 'f6', label: 'Why do you want to work here?' },
  { id: 'f7', label: 'What is your gender identity?' },
]));
const m = JSON.parse(run('match', '--file', fields, '--company', 'Anthropic').stdout);
const ids = (b) => m[b].map((x) => x.id).sort();
ok('match: auto = authorization, sponsorship, start date, interviewed-before (Anthropic scope)', JSON.stringify(ids('auto')) === JSON.stringify(['f1', 'f2', 'f3', 'f5']));
ok('match: confirm = relocation (confirm_each_time)', JSON.stringify(ids('confirm')) === JSON.stringify(['f4']));
ok('match: unknown = free text + demographic, never guessed', JSON.stringify(ids('unknown')) === JSON.stringify(['f6', 'f7']));
const m2 = JSON.parse(run('match', '--file', fields, '--company', 'CoreWeave').stdout);
ok('the Anthropic-scoped entry is invisible for CoreWeave', m2.unknown.some((x) => x.id === 'f5'));

const list = run('list');
ok('list renders answered and pending markers', list.status === 0 && /✅/.test(list.stdout));
rmSync(dir, { recursive: true, force: true });
