// tests/doctor-unfilled-templates.test.mjs — doctor must notice when a
// personalization file EXISTS but still carries template content.
//
// Why this matters: doctor auto-copies `modes/_profile.md` and `modes/_brief.md`
// from their templates on first run, so the existence check can never fail for
// them. Left unedited, `_profile.md` feeds the template author's archetypes into
// every A-F evaluation — the system looks healthy and scores against a stranger.
//
// Each scenario uses a fresh --target dir so nothing leaks across cases.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\ndoctor.mjs — unfilled personalization templates');

const DOCTOR = join(ROOT, 'doctor.mjs');
const dirs = [];

function runDoctor(cwd) {
  try {
    const out = execFileSync(NODE, [DOCTOR, '--json', '--target', cwd], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return JSON.parse(out);
  } catch (e) {
    return { _error: e.message };
  }
}

// Builds a target dir carrying the REAL templates, so the test tracks whatever
// placeholder vocabulary the shipped templates actually use.
function fixture(label) {
  const dir = mkdtempSync(join(tmpdir(), `co-unfilled-${label}-`));
  dirs.push(dir);
  mkdirSync(join(dir, 'modes'), { recursive: true });
  for (const f of ['_profile.template.md', '_brief.template.md', '_custom.template.md']) {
    writeFileSync(join(dir, 'modes', f), readFileSync(join(ROOT, 'modes', f), 'utf-8'));
  }
  return dir;
}

const flagged = (state, path) => (state.unpersonalized || []).some((u) => u.path === path);

try {
  // 1. The real cold-start shape: doctor auto-copies the templates, so both
  //    files exist and are byte-identical. Existence says healthy; content
  //    must not.
  {
    const dir = fixture('identical');
    const s = runDoctor(dir);
    if (s._error) fail(`auto-copied templates: doctor crashed: ${s._error}`);
    else if (flagged(s, 'modes/_profile.md') && flagged(s, 'modes/_brief.md')) {
      pass('auto-copied templates are reported as unpersonalized');
    } else {
      fail(`auto-copied templates not flagged: ${JSON.stringify(s.unpersonalized)}`);
    }
  }

  // 2. Non-blocking: an unedited personalization file is a warning, never a
  //    gate. career-ops is documented as working out of the box.
  {
    const dir = fixture('nonblocking');
    const s = runDoctor(dir);
    if (s._error) fail(`non-blocking: doctor crashed: ${s._error}`);
    else if ((s.unpersonalized || []).length > 0 && s.warnings.some((w) => w.includes('_profile.md'))) {
      pass('unpersonalized files surface in warnings without gating onboarding');
    } else {
      fail('unpersonalized files did not reach the warnings array');
    }
  }

  // 3. Edited but still carrying the template's own placeholders — the halfway
  //    state where someone filled the top and stopped.
  {
    const dir = fixture('placeholders');
    writeFileSync(join(dir, 'modes', '_brief.md'),
      '# Jane Smith — Triage Brief\n\n## Identity\nSenior Backend Engineer.\n\n' +
      '| 1 | **{Archetype name}** | {the capability/experience that makes you a fit} |\n');
    const s = runDoctor(dir);
    const hit = (s.unpersonalized || []).find((u) => u.path === 'modes/_brief.md');
    if (s._error) fail(`placeholders: doctor crashed: ${s._error}`);
    else if (hit && /placeholder/.test(hit.reason)) pass(`leftover placeholders detected (${hit.reason})`);
    else fail(`leftover placeholders not detected: ${JSON.stringify(s.unpersonalized)}`);
  }

  // 4. No false positives. Real personalized content that happens to contain
  //    braces (a JSON snippet in someone's house rules) must stay clean — the
  //    check compares against the TEMPLATE's placeholder set, not any `{...}`.
  {
    const dir = fixture('clean');
    writeFileSync(join(dir, 'modes', '_profile.md'),
      '# Profile\n\n## Your Target Roles\n| **Backend Engineer** | Go, Postgres | ships services |\n' +
      'Config sample: `{"retries": 3}` and a shell brace `${HOME}`.\n');
    writeFileSync(join(dir, 'modes', '_brief.md'),
      '# Jane Smith — Triage Brief\n\n## Identity\nSenior Backend Engineer, US remote.\n');
    const s = runDoctor(dir);
    if (s._error) fail(`clean: doctor crashed: ${s._error}`);
    else if ((s.unpersonalized || []).length === 0) pass('personalized files with literal braces are not flagged');
    else fail(`false positive on personalized content: ${JSON.stringify(s.unpersonalized)}`);
  }

  // 5. `modes/_custom.md` is deliberately exempt: it holds optional procedural
  //    house rules, so shipping it unedited is a valid end state, not a defect.
  {
    const dir = fixture('custom-exempt');
    writeFileSync(join(dir, 'modes', '_profile.md'), '# Profile\nBackend Engineer.\n');
    writeFileSync(join(dir, 'modes', '_brief.md'), '# Brief\nBackend Engineer.\n');
    const s = runDoctor(dir);
    if (s._error) fail(`custom-exempt: doctor crashed: ${s._error}`);
    else if (!flagged(s, 'modes/_custom.md')) pass('modes/_custom.md left as template is not flagged');
    else fail('modes/_custom.md was flagged, but unedited house rules are a valid end state');
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } }
}
