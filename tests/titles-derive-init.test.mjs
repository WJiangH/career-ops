// tests/titles-derive-init.test.mjs — `titles-derive.mjs --init`, the day-zero path.
//
// A new checkout has no portals.yml. doctor.mjs used to answer that with
// `cp templates/portals.example.yml portals.yml`, which hands the user the
// template author's keywords and never consults cv.md. --init keeps the copy
// (companies, boards and negatives have no derivation path) and then decides
// what to do with title_filter.positive from ONE fact: did a model run?
//
//   no CLI / --no-llm → the template's keywords, verbatim (the original flow)
//   a model ran       → the CV-derived set replaces them
//
// The model half is not exercised here — it needs a CLI on PATH. What is
// pinned is everything around it: the scaffold, the refusal to run twice, the
// no-CLI fallback being byte-identical to the template, and the --write path
// still refusing to touch a checkout that has no portals.yml.

import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';

console.log('\ntitles-derive --init — day-zero scaffold');

const ok = (msg, cond) => (cond ? pass(msg) : fail(msg));

// A minimal checkout: the script resolves everything from process.cwd(), and
// imports scan.mjs, which needs its own tree — so run the REAL script from the
// repo root against a temp cwd? No: ROOT is cwd, so the script must be copied
// too, with the modules it imports resolvable. Symlinking the whole repo would
// share portals.yml. Instead: copy the few files it reads, and point node at
// the repo's script with cwd = the temp dir; its imports resolve relative to
// the script file, its reads relative to cwd.
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'titles-init-'));
  mkdirSync(join(dir, 'templates'), { recursive: true });
  mkdirSync(join(dir, 'modes'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  cpSync(join(ROOT, 'templates', 'portals.example.yml'), join(dir, 'templates', 'portals.example.yml'));
  cpSync(join(ROOT, 'modes', 'titles-init.md'), join(dir, 'modes', 'titles-init.md'));
  writeFileSync(join(dir, 'cv.md'), [
    '# Jane Smith',
    '',
    '## Experience',
    '',
    '### Machine Learning Engineer — Acme',
    '*2023 — Present*',
    '',
    '- Optimize LLM inference with quantization on edge silicon.',
    '',
    '## Skills',
    '',
    '**ML Systems:** LLM Inference Optimization, Model Quantization',
    '',
  ].join('\n'));
  return dir;
}

function run(cwd, ...args) {
  return spawnSync(NODE, [join(ROOT, 'titles-derive.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', CAREER_OPS_ROOT: cwd }, // no CLI on PATH; user layer = the temp checkout
  });
}

const templatePositive = yaml.load(readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf8')).title_filter.positive;

// ── no CLI: template kept verbatim ───────────────────────────────────────────
{
  const dir = checkout();
  const r = run(dir, '--init');
  ok('--init exits 0 without a CLI', r.status === 0);
  ok('--init creates portals.yml', existsSync(join(dir, 'portals.yml')));
  const written = readFileSync(join(dir, 'portals.yml'), 'utf8');
  const tpl = readFileSync(join(dir, 'templates', 'portals.example.yml'), 'utf8');
  ok('without a model the file is the template, byte for byte', written === tpl);
  ok('stderr says the template keywords were kept', /keeping the template/.test(r.stderr));
  ok('stdout still prints the CV-derived candidates as advice', /candidates from cv\.md/.test(r.stdout));
  ok('stdout names the template as the source of title_filter.positive', /title_filter\.positive is the template/.test(r.stdout));

  const again = run(dir, '--init');
  ok('a second --init refuses rather than overwriting', again.status === 1 && /already exists/.test(again.stderr));
  ok('…and leaves the file untouched', readFileSync(join(dir, 'portals.yml'), 'utf8') === tpl);
  rmSync(dir, { recursive: true, force: true });
}

// ── --no-llm is the same fallback, said explicitly ───────────────────────────
{
  const dir = checkout();
  const r = run(dir, '--init', '--no-llm', '--json');
  ok('--init --no-llm --json exits 0', r.status === 0);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* fall through */ }
  ok('JSON carries the init verdict', j?.init?.keywords_written === false && /portals\.example\.yml$/.test(j?.init?.scaffolded_from ?? ''));
  const p = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
  ok('title_filter.positive equals the template\'s', JSON.stringify(p.title_filter.positive) === JSON.stringify(templatePositive));
  ok('the template keywords are reported as unsupported by this CV', Array.isArray(j?.unsupported_by_cv) && j.unsupported_by_cv.length > 0);
  rmSync(dir, { recursive: true, force: true });
}

// ── guards ───────────────────────────────────────────────────────────────────
{
  const dir = checkout();
  const both = run(dir, '--init', '--write');
  ok('--init with --write is rejected', both.status === 1 && /different situations/.test(both.stderr));
  ok('…and nothing was scaffolded', !existsSync(join(dir, 'portals.yml')));

  const write = run(dir, '--write', '--no-llm');
  ok('--write on a checkout with no portals.yml refuses and points at --init', write.status === 1 && /--init/.test(write.stderr));

  const bogus = run(dir, '--bogus');
  ok('an unknown flag is rejected', bogus.status !== 0 && /unrecognized flag/.test(bogus.stderr));
  rmSync(dir, { recursive: true, force: true });
}
