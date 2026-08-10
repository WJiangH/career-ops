#!/usr/bin/env node

/**
 * cv-evidence-gap.mjs — skills your CV claims but never demonstrates.
 *
 * Zero-LLM. Complements the two tools that already exist by answering the
 * question neither of them asks:
 *
 *   upskill.mjs       "what should I go learn?"  — excludes anything in cv.md
 *   jd-skill-gap.mjs  "does one JD's ask appear in cv.md at all?"
 *   this              "what does cv.md CLAIM but never back up?"
 *
 * The distinction is not academic. Across 19 evaluations of one real CV, nine
 * reports flagged C++ — not as missing, but as "listed as a skill and never
 * evidenced in a bullet". upskill.mjs excluded it precisely because it IS in
 * the Skills section, so the single most repeated objection in the pipeline was
 * invisible to the tooling. A bare skills list is the weakest claim a CV can
 * make; a reviewer discounts it, and so does an evaluator.
 *
 * Reads: cv.md (Skills section vs everything else), reports/*.md (how often
 * each term is actually objected to). Writes nothing, ever — it reports where
 * the user's own evidence is missing, and only they can supply it.
 *
 * Usage:
 *   node cv-evidence-gap.mjs
 *   node cv-evidence-gap.mjs --summary
 *   node cv-evidence-gap.mjs --self-test
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { canonicalize } from './skill-extract.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CV = join(ROOT, 'cv.md');
const REPORTS = join(ROOT, 'reports');

/**
 * Split cv.md into the skills inventory and the prose that could evidence it.
 *
 * "Skills" is where claims are cheap; Experience/Projects/Summary is where they
 * cost something. A term appearing only on the left is an assertion, not a
 * demonstration.
 */
export function splitCv(md) {
  const lines = md.split('\n');
  const skills = [];
  const prose = [];
  let inSkills = false;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      // Match the heading loosely: "Skills", "Skills & Tools", "Technical Skills".
      inSkills = /skills?(\s*&|\s+and)?(\s+tools?)?\s*$/i.test(h[1].trim());
      continue;
    }
    (inSkills ? skills : prose).push(line);
  }
  return { skillsText: skills.join('\n'), proseText: prose.join('\n') };
}

/**
 * Terms listed in the Skills section.
 *
 * Deliberately NOT extractSkills(): that maps onto a fixed vocabulary, and the
 * claims worth auditing are whatever this CV actually wrote — including terms
 * no shared token list knows ("GGUF", "E(3) GNNs"). Splits on the separators
 * the section format uses, then drops parenthetical asides.
 */
export function listedSkills(skillsText) {
  const out = [];
  for (const raw of skillsText.split('\n')) {
    // Category lines look like "**ML & AI:** PyTorch, TensorFlow | Bayesian…"
    const body = raw.replace(/^\s*\*\*[^*]+:\*\*/, '').trim();
    if (!body || body.startsWith('#')) continue;
    for (const piece of body.split(/[,|·;]/)) {
      // Strip a trailing aside — "Cloud Deployment (Azure)" — but keep inline
      // parentheses that are part of the name, or "E(3) GNNs" becomes "E GNNs".
      const t = piece.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (t.length >= 2 && t.length <= 40 && /[A-Za-z]/.test(t)) out.push(t);
    }
  }
  return [...new Set(out)];
}

/**
 * Is the term demonstrated in the prose?
 *
 * Substring, case-insensitive, on a normalized copy — punctuation and spacing
 * differ constantly between a skills list and a sentence ("llama.cpp" vs
 * "llama.cpp (GGUF, quantization)", "NPU/GPU Acceleration" vs "NPU silicon").
 * A term of two words or more also counts as evidenced when ALL its words
 * appear in one prose line, which catches "Model Quantization" against
 * "…quantization, and kernel-level tuning" without matching across paragraphs.
 */
export function evidencedInProse(term, proseText) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9+#./ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(term);
  if (!t) return false;
  const prose = norm(proseText);
  if (prose.includes(t)) return true;

  const words = t.split(' ').filter((w) => w.length > 2);
  if (words.length < 2) return false;
  if (proseText.split('\n').some((line) => { const l = norm(line); return words.every((w) => l.includes(w)); })) return true;

  // Head-noun fallback. A skills list writes "Latency Profiling" where a bullet
  // writes "Profile the NPU inference stack end-to-end to locate bottlenecks" —
  // the same claim, demonstrated. Requiring every word flagged both that and
  // "Cloud Deployment" against "deployed … on cloud infrastructure", telling the
  // user to evidence things their CV already evidences. A false positive here is
  // worse than a miss: it spends their attention and costs the tool its
  // credibility. Longest word only, and ≥6 chars so "Model"/"Cloud" alone never
  // carries a match.
  const head = words.slice().sort((a, b) => b.length - a.length)[0];
  return head.length >= 6 && prose.includes(head);
}

/**
 * Gap statements a report actually made, from its `## Machine Summary` block.
 *
 * The first cut scanned the whole report for the term near a negation word and
 * was badly wrong: it counted an analysis row reading "Python: strong match.
 * C++: evidenced at the llama.cpp scope" as an objection to all four languages
 * named in it, because the sentence contains "not" elsewhere. Reports argue
 * both sides of every skill in prose — only hard_stops and soft_gaps are the
 * report's conclusions, and they are already structured.
 */
export function gapStatements(reportText) {
  const m = reportText.match(/#{1,4}\s*Machine Summary\s*\n+```[a-zA-Z]*\n([\s\S]*?)\n```/);
  if (!m) return [];
  const out = [];
  let inList = false;
  for (const line of m[1].split('\n')) {
    if (/^(hard_stops|soft_gaps)\s*:/.test(line)) { inList = true; continue; }
    if (/^[a-z_]+\s*:/.test(line)) { inList = false; continue; }
    if (!inList) continue;
    const item = line.match(/^\s*-\s*"?(.*?)"?\s*$/);
    if (item && item[1].trim()) out.push(item[1].trim());
  }
  return out;
}

/** How many evaluations listed the term in a gap, and one example. */
export function objectionsFor(term, reportTexts) {
  const t = term.toLowerCase();
  let count = 0;
  let example = '';
  for (const text of reportTexts) {
    const hit = gapStatements(text).find((g) => g.toLowerCase().includes(t));
    if (!hit) continue;
    count++;
    if (!example) example = hit.slice(0, 200);
  }
  return { count, example };
}

function readReports() {
  try {
    return readdirSync(REPORTS)
      .filter((f) => f.endsWith('.md') && !f.includes('RESERVED'))
      .map((f) => readFileSync(join(REPORTS, f), 'utf8'));
  } catch {
    return [];
  }
}

export function analyze(cvMd, reportTexts) {
  const { skillsText, proseText } = splitCv(cvMd);
  const listed = listedSkills(skillsText);
  const findings = [];
  for (const term of listed) {
    if (evidencedInProse(term, proseText)) continue;
    const { count, example } = objectionsFor(term, reportTexts);
    findings.push({ term, objections: count, example });
  }
  // Objected-to first: those are costing real evaluations today. Alphabetical
  // within a tier so the output is stable between runs.
  findings.sort((a, b) => b.objections - a.objections || a.term.localeCompare(b.term));
  return { listed: listed.length, unevidenced: findings.length, reports: reportTexts.length, findings };
}

// ── self-test ────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => (cond ? (pass++, console.log(`  ✅ ${msg}`)) : (fail++, console.log(`  ❌ ${msg}`)));

  const cv = [
    '## Summary', 'Engineer who tunes llama.cpp and quantization on NPU silicon.', '',
    '## Professional Experience', '### Role — Co', '- Built TensorFlow models and shipped inference APIs.', '',
    '## Skills & Tools', '**A:** llama.cpp, C++, TensorFlow, Model Quantization | Kubernetes', '',
    '## Education', '- PhD',
  ].join('\n');

  const { skillsText, proseText } = splitCv(cv);
  ok(skillsText.includes('llama.cpp') && !skillsText.includes('PhD'), 'Skills section isolated from later sections');
  ok(proseText.includes('TensorFlow models') && !proseText.includes('**A:**'), 'prose excludes the skills list');

  const listed = listedSkills(skillsText);
  ok(listed.includes('C++') && listed.includes('Model Quantization'), 'splits on both , and | separators');

  ok(evidencedInProse('llama.cpp', proseText), 'exact term in prose counts as evidenced');
  ok(evidencedInProse('Model Quantization', proseText), 'multi-word term matches words in one line ("quantization")');
  ok(!evidencedInProse('Kubernetes', proseText), 'term absent from prose is not evidenced');
  ok(!evidencedInProse('C++', proseText), 'a bare skills-list claim is not evidence');

  // Objections are read from the structured block, not prose. The second report
  // deliberately argues BOTH sides of C++ in its body while concluding nothing
  // about it — the shape that made the first implementation count phantom
  // objections for every language named in a comparison row.
  const mkReport = (gaps, body = '') => [
    '# Evaluation', body, '', '## Machine Summary', '', '```yaml', 'score: 2.0',
    'hard_stops:', ...gaps.map((g) => `  - "${g}"`), 'risk_level: "Low"', '```', '',
  ].join('\n');
  const reports = [
    mkReport(['C++ is listed as a skill but never evidenced in a bullet']),
    mkReport(['No Kubernetes experience anywhere'], '| Python + modern C/C++ | Python: strong match. C++: evidenced at the llama.cpp scope, not a large codebase |'),
  ];
  ok(objectionsFor('C++', reports).count === 1, 'counts only the structured gap, not a prose comparison row');
  ok(objectionsFor('TensorFlow', reports).count === 0, 'no objection when unmentioned');
  ok(gapStatements(reports[1]).length === 1, 'gapStatements reads hard_stops and stops at the next key');

  const r = analyze(cv, reports);
  ok(r.findings.some((f) => f.term === 'C++' && f.objections === 1), 'C++ surfaces as claimed-but-unevidenced');
  ok(!r.findings.some((f) => f.term === 'llama.cpp'), 'evidenced skills are not reported');
  ok(r.findings[0].term === 'C++' || r.findings[0].objections >= r.findings[1]?.objections, 'objected-to findings rank first');

  console.log(`\n${fail === 0 ? '🟢' : '🔴'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

if (!existsSync(CV)) {
  console.error('cv.md not found — nothing to audit.');
  process.exit(1);
}
const result = analyze(readFileSync(CV, 'utf8'), readReports());

if (!argv.includes('--summary')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('CV EVIDENCE GAP');
  console.log(`${result.listed} skills listed · ${result.unevidenced} never demonstrated in prose · ${result.reports} reports scanned\n`);
  if (result.findings.length === 0) {
    console.log('  Every listed skill appears somewhere in your experience. Nothing to fix.');
  } else {
    const flagged = result.findings.filter((f) => f.objections > 0);
    const quiet = result.findings.filter((f) => f.objections === 0);
    if (flagged.length) {
      console.log('  COSTING YOU NOW — evaluations have objected to these:\n');
      for (const f of flagged) {
        console.log(`    ${f.term}  — ${f.objections} report${f.objections === 1 ? '' : 's'}`);
        if (f.example) console.log(`      "${f.example}"`);
      }
      console.log('');
    }
    if (quiet.length) {
      console.log('  Listed but never shown (no objection yet):');
      console.log(`    ${quiet.map((f) => f.term).join(', ')}\n`);
    }
    console.log('  A skills list is the weakest claim a CV can make. Move each of these into a');
    console.log('  bullet that shows it being used — or drop it. Nothing here is auto-applied:');
    console.log('  only you know which are real.');
  }
}
