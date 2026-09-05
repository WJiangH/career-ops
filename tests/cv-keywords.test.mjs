// tests/cv-keywords.test.mjs — the mechanical cv.md → keyword pass (#2751).
//
// This layer exists to be the half of keyword derivation that does NOT need a
// model, so the two properties worth defending are:
//
//   1. DETERMINISM. The model path returned 19 keywords on one run of this CV
//      and 12 on the next. If this layer drifts too there is nothing to build
//      a confirm-gate on.
//   2. FORMAT TOLERANCE. cv.md has no schema — doctor.mjs says only "Create
//      cv.md ... with your CV in markdown". So the tests below feed it CVs
//      written four different ways, not just the one in this checkout.
//
// A CV whose headings are unrecognized must yield FEWER keywords, never wrong
// ones — every assertion about a miss is also an assertion that nothing bogus
// took its place.

import { pass, fail } from './helpers.mjs';
import { readFileSync } from 'fs';
import { splitCvSections, sectionKey, CV_HEADING_RE } from '../cv-headings.mjs';
import { buildTitleFilter } from '../scan.mjs';
import {
  ngrams, readSkills, readRoleTitles, readCv, deriveKeywords,
  unsupportedByCv, subsumes, redundancyGroups, GENERIC_ALONE,
} from '../lib/cv-keywords.mjs';

console.log('\ncv-headings — section splitting');

const eq = (msg, actual, expected) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass(msg); else fail(`${msg} — got ${a}, expected ${b}`);
};
const ok = (msg, cond) => (cond ? pass(msg) : fail(msg));

// ── nesting: the bug that made Experience read as empty ──────────────────────

const NESTED = `# Jane Smith
jane@example.com

## Professional Experience

### Senior ML Engineer — Acme, SF
- did things

### Data Scientist — Beta Corp
- more things

## Skills & Tools

**Core:** Inference, Quantization
`;

{
  const sections = splitCvSections(NESTED);
  const keys = sections.map((s) => s.key);
  ok('entry headings do not start their own section', !keys.includes('senior ml engineer — acme, sf'));
  const exp = sections.find((s) => s.key === 'experience');
  ok('the experience section keeps its entries in its body', !!exp && exp.body.includes('Senior ML Engineer'));
  ok('and does not swallow the next section', !!exp && !exp.body.includes('Inference, Quantization'));
}

{
  // A CV whose shallowest heading is used once is a NAME, so sections are one
  // level down. A CV with no such name line must not lose its first section.
  const noName = `## Experience\n\n### Role — Co\n\n## Skills\n\n**A:** B\n`;
  const keys = splitCvSections(noName).map((s) => s.key);
  ok('no name line: both sections still found', keys.includes('experience') && keys.includes('skills'));
}

{
  // Everything one level deeper — the same document, shifted.
  const deep = `### Jane\n\n#### Work Experience\n\n##### Role — Co\n\n#### Skills\n\n**A:** B\n`;
  const keys = splitCvSections(deep).map((s) => s.key);
  ok('heading depth is relative, not assumed to be ##', keys.includes('experience') && keys.includes('skills'));
}

eq('an unrecognized heading keeps its own text as the key rather than vanishing',
  splitCvSections('## Volunteering\n\nstuff\n').map((s) => s.key), ['volunteering']);

// ── alias coverage comes from the shared table, not a private copy ───────────

eq('sectionKey folds spellings and languages', [
  sectionKey('Professional Experience'), sectionKey('Work Experience'),
  sectionKey('Doświadczenie zawodowe'), sectionKey('Technical Skills'),
], ['experience', 'experience', 'experience', 'skills']);

ok('CV_HEADING_RE accepts any level and indentation',
  CV_HEADING_RE.test('# A') && CV_HEADING_RE.test('   ###### B') && CV_HEADING_RE.test('## C ##'));

console.log('\ncv-keywords — reading');

// ── skills: the four shapes a list is written in ─────────────────────────────

eq('bold label with the colon inside the emphasis',
  readSkills('**ML Systems & Inference:** Inference, Quantization'),
  [{ label: 'ML Systems & Inference', items: ['Inference', 'Quantization'] }]);

eq('bold label with the colon outside',
  readSkills('**ML & AI**: PyTorch, RLHF'),
  [{ label: 'ML & AI', items: ['PyTorch', 'RLHF'] }]);

eq('bulleted label', readSkills('- Languages: Python, C++'),
  [{ label: 'Languages', items: ['Python', 'C++'] }]);

eq('table row: first cell labels the rest',
  readSkills('| Tools | Git, Linux |'), [{ label: 'Tools', items: ['Git', 'Linux'] }]);

eq('a bare comma list needs no label',
  readSkills('Inference, Quantization, NPU'),
  [{ label: '', items: ['Inference', 'Quantization', 'NPU'] }]);

eq('pipes and bullets separate items too',
  readSkills('**A:** x | y · z'), [{ label: 'A', items: ['x', 'y', 'z'] }]);

// ── experience: the four ways a CV punctuates "Title, Company" ───────────────

eq('em dash / pipe / at / comma all separate the title from the company',
  readRoleTitles([
    '### Senior ML Engineer — Acme',
    '### Data Scientist | Beta | 2024',
    '### Research Engineer @ Gamma',
    '**Staff Engineer**, Delta',
  ].join('\n')).titles,
  ['ML Engineer', 'Data Scientist', 'Research Engineer', 'Engineer']);

eq('the company is returned too, so the prose rule can exclude an employer name',
  readRoleTitles('### Senior ML Engineer — Axiado, San Jose, CA').companies,
  ['Axiado', 'San Jose', 'CA']);

eq('a level is stripped, a role word is not',
  readRoleTitles('### Postdoctoral Research Fellow — JHU\n### Data Science Intern — Dow').titles,
  ['Research Fellow', 'Data Science']);

// ── the tool/domain split comes from the CV's own labels ─────────────────────

{
  const cv = `## Skills

**ML Systems & Inference:** Quantization, llama.cpp
**Programming & Data:** Python, SQL
**Tools:** Git, VSCode
`;
  const r = readCv(cv);
  eq('domain groups kept', r.domain.map((g) => g.label), ['ML Systems & Inference']);
  eq('tooling labels excluded', r.tools.map((g) => g.label), ['Programming & Data', 'Tools']);
}

ok('an unlabelled group is treated as domain, not silently dropped',
  readCv('## Skills\n\nInference, Quantization\n').domain.length === 1);

ok('education is never read — "Virginia Tech" would yield the 1-gram "Tech"',
  !deriveKeywords('## Education\n\n### Virginia Tech — PhD\n').some((d) => /tech/i.test(d.keyword)));

// ── n-grams ──────────────────────────────────────────────────────────────────

ok('windows never cross a slash or a parenthetical',
  !ngrams('Edge / On-Device Deployment').some((g) => g.includes('/')) &&
  !ngrams('E(3) GNNs').some((g) => g.includes('3')));

ok('a slash splits two claims into both of them',
  ngrams('NPU/GPU Acceleration').includes('NPU') && ngrams('NPU/GPU Acceleration').includes('GPU'));

ok('hyphens, dots and plus signs stay inside a token',
  ngrams('On-Device').includes('On-Device') &&
  ngrams('llama.cpp').includes('llama.cpp') &&
  ngrams('C++').includes('C++'));

eq('the longest window comes first', ngrams('Model Quantization')[0], 'Model Quantization');

// ── determinism: the whole point of this layer ───────────────────────────────

console.log('\ncv-keywords — determinism and the derive pass');

{
  const cv = `# A

## Experience

### Senior ML Engineer — Acme

## Skills

**ML Systems & Inference:** Model Quantization, Edge / On-Device Deployment
**Tools:** Git
`;
  const runs = Array.from({ length: 5 }, () => JSON.stringify(deriveKeywords(cv)));
  ok('five runs over the same CV are byte-identical', new Set(runs).size === 1);

  const kws = deriveKeywords(cv).map((d) => d.keyword);
  ok('the short matchable form is produced, not only the CV\'s long phrase',
    kws.includes('Quantization') && kws.includes('On-Device'));
  ok('tooling stayed out', !kws.includes('Git'));
  ok('every candidate carries the line it came from',
    deriveKeywords(cv).every((d) => d.from && d.source));
}

ok('bare head nouns are marked, not deleted — the CV really does say them',
  deriveKeywords('## Experience\n\n### ML Engineer — Acme\n').some((d) => d.keyword === 'Engineer' && d.generic));

ok('GENERIC_ALONE only ever marks single words',
  [...GENERIC_ALONE].every((w) => !w.includes(' ')));

// ── removals ─────────────────────────────────────────────────────────────────

{
  const derived = deriveKeywords('## Skills\n\n**Core:** Model Quantization, Inference\n');
  eq('a keyword the CV does not support is reported',
    unsupportedByCv(['Quantization', 'KI Trainer', 'Inference'], derived), ['KI Trainer']);
  eq('containment counts in both directions',
    unsupportedByCv(['LLM Inference', 'Model'], derived), []);
  eq('an empty current list yields nothing to remove', unsupportedByCv([], derived), []);
  eq('a missing current list does not throw', unsupportedByCv(undefined, derived), []);
}

// ── redundancy ───────────────────────────────────────────────────────────────

console.log('\ncv-keywords — redundancy under the scanner\'s matching rule');

ok('a 4+ char keyword subsumes anything containing it',
  subsumes('Inference', 'LLM Inference Optimization') && subsumes('Quantization', 'Model Quantization'));

ok('a 2-3 char keyword subsumes nothing — it is matched on word boundaries',
  !subsumes('ML', 'ML Systems') && !subsumes('LLM', 'LLM Inference') && !subsumes('AI', 'AI Data'));

{
  // The regression this rule exists for. Probing with invented titles reported
  // all three of the pairs above as subsumed, because the probe titles happened
  // to put a word boundary before the short keyword. "HTML Systems Engineer"
  // contains "ML Systems" and does NOT match \bml\b, so dropping `ML Systems`
  // in favour of `ML` would lose a posting.
  const f = buildTitleFilter({ positive: ['ML'], negative: [] });
  ok('proof: \\bml\\b does not match a title that contains "ML Systems"', !f('HTML Systems Engineer'));
}

ok('subsumption is not reflexive', !subsumes('Inference', 'Inference'));
ok('case is ignored', subsumes('inference', 'LLM INFERENCE'));

eq('a group names the broader keyword and everything it covers',
  redundancyGroups(['Inference', 'LLM Inference', 'Inference Optimization', 'Quantization']),
  [{ broad: 'Inference', covers: ['LLM Inference', 'Inference Optimization'] }]);

eq('unrelated keywords form no group', redundancyGroups(['Inference', 'Quantization', 'NPU']), []);

ok('every group is a real decision — the broad keyword is never in its own covers',
  redundancyGroups(deriveKeywords(readFileSync(new URL('../cv.md', import.meta.url), 'utf-8')).map((d) => d.keyword))
    .every((g) => !g.covers.includes(g.broad)));

// ── tolerance: less, never wrong ─────────────────────────────────────────────

console.log('\ncv-keywords — unfamiliar formats degrade, they do not corrupt');

for (const [label, cv] of [
  ['empty', ''],
  ['no headings at all', 'Jane Smith\nML Engineer at Acme\n'],
  ['headings we do not know', '## Werdegang\n\n### ML Engineer — Acme\n'],
  ['a heading with no body', '## Skills\n'],
  ['html in a heading', '## <b>Skills</b>\n\n**A:** Inference\n'],
]) {
  let out;
  try {
    out = deriveKeywords(cv);
  } catch (e) {
    fail(`${label}: threw — ${e.message}`);
    continue;
  }
  ok(`${label}: returns an array without throwing`, Array.isArray(out));
  ok(`${label}: every entry is a non-empty string`, out.every((d) => typeof d.keyword === 'string' && d.keyword.length > 1));
}

ok('an unrecognized section contributes nothing rather than garbage',
  deriveKeywords('## Werdegang\n\n### ML Engineer — Acme\n').length === 0);
