/**
 * cv-keywords.mjs — derive `title_filter.positive` candidates from cv.md, with
 * no model and no network.
 *
 * The gap this closes (issue #2751): cv.md is read all over the repo, but only
 * ever as a document handed whole to an LLM (`oferta`, `pdf`) or as headings
 * for a consistency check (generate-pdf.mjs). Nothing turns it into the short
 * keyword list the SCANNER needs, so day-zero `portals.yml` comes from
 * `cp templates/portals.example.yml` — the template author's market.
 *
 * ── Why reading, not extraction ──────────────────────────────────────────────
 *
 * A CV's Skills section is already a keyword list the candidate authored, and
 * its Experience headings are already job titles. The job here is to READ two
 * lists, not to discover phrases in prose. Three alternatives were measured
 * against this repo's own cv.md before settling on that:
 *
 *   RAKE / YAKE / TextRank — score by degree/frequency, which rewards LONG
 *     phrases. Top hit: "Built TensorFlow-based predictive models integrated
 *     into kinetic Monte Carlo frameworks". A substring title filter needs the
 *     opposite. Not a tuning problem; the objective is inverted.
 *   O*NET / ESCO occupational taxonomies — 57,543 O*NET titles contain zero of
 *     `quantization`, `inference`, `kernel`, `gpu`, `on-device`, `mlops`, `rtl`.
 *     Government classifications move in years. Substring-matching them also
 *     reproduces the false positives: llm→Be(llm)an, npu→Data I(npu)t Clerk,
 *     edge→Know(ledge) Manager.
 *   A scraped corpus of live ATS titles — self-selecting when taken from
 *     scan-history (those are the postings the CURRENT filter already admitted,
 *     so a missing keyword scores 0 by construction), and alphabetically
 *     truncated when swept fresh (`--limit` walks a sorted directory: 9,661
 *     titles, 6,545 of them from companies starting A or B).
 *
 * ── Format tolerance ─────────────────────────────────────────────────────────
 *
 * Sections are found with cv-headings.mjs — any heading level, diacritics
 * folded, an alias table already covering EN and PL spellings. NOTHING here
 * assumes a body layout before knowing which section it is in. Within a
 * section, each of the handful of shapes a list is written in is handled
 * explicitly. A CV whose headings are unrecognized yields fewer keywords; it
 * never yields wrong ones.
 */

import { splitCvSections } from '../cv-headings.mjs';

/** Words that are never a role family on their own. */
const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
]);

/** A level, not a role family — stripped off the front of a CV job title. */
const SENIORITY_PREFIX =
  /^(sr\.?|senior|staff|principal|lead|head|chief|junior|jr\.?|associate|assistant|postdoctoral|postdoc|graduate|grad|r&d|intern|founding)\s+/i;

/**
 * Same, off the end.
 *
 * `Fellow` and `Assistant` are deliberately NOT here even though they read like
 * levels: "Research Fellow" and "Research Assistant" are title families in
 * their own right, and stripping the tail leaves a bare "Research" that matches
 * Clinical Research Coordinator and Market Research Analyst. A level is only a
 * level when removing it still leaves a role.
 */
const SENIORITY_SUFFIX = /\s+(intern|internship|trainee|i{1,3}|iv|[1-5])$/i;

/**
 * Sections worth reading, and what they contain. Anything else — education,
 * awards, publications, summary prose — is skipped.
 *
 * `education` is the one that must be excluded explicitly rather than by
 * accident: "Virginia Tech" yields the 1-gram "Tech", which matches a quarter
 * of all job titles.
 */
const READ_SECTIONS = new Set(['experience', 'skills', 'competencies']);

/**
 * Which section is this, when the alias table did not recognize the heading?
 *
 * `sectionKey` is exact by design and is used by generate-pdf.mjs to decide
 * whether a rendered PDF's section order matches cv.md's — loosening it there
 * would change what that gate accepts. So the fuzziness lives here instead,
 * where the cost of a wrong guess is a keyword in a diff the user reviews.
 *
 * The rule: a heading the table missed is treated as section X when X's name
 * appears in it as a whole word. `Skills & Tools` → skills. `Experience
 * (selected)` → experience. Checked longest-first so `Core Competencies` is not
 * claimed by a shorter name that happens to be a substring.
 *
 * @param {string} key - `sectionKey`'s output (canonical, or the raw heading).
 * @returns {string} a READ_SECTIONS member, or the key unchanged.
 */
function looseSectionKey(key) {
  if (READ_SECTIONS.has(key)) return key;
  const names = [...READ_SECTIONS].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(key)) return name;
  }
  return key;
}

/**
 * A skills-category label that names TOOLING rather than a domain.
 *
 * This is the signal that removes `PyTorch`, `Slurm`, `VSCode`, `NumPy` and
 * `llama.cpp` for free, and it comes from the candidate: a CV that writes
 * `**Tools:** Linux, Git, VSCode` has already classified them. Frequency
 * statistics were tried for this job and are strictly worse — a thin corpus
 * cannot tell a rare-but-right keyword from a non-word.
 *
 * Domain labels are the default. A label is only treated as tooling when it
 * says so, so an unrecognized label errs toward keeping the terms (a noisy
 * keyword is visible in the diff; a dropped one is invisible).
 */
const TOOL_LABEL =
  /\b(tool|tooling|technolog|software|platform|language|programming|framework|librar|stack|environment|ide|database|cloud|devops|infrastructure tool)/i;

/**
 * Split a CV heading or list entry into every 1-, 2- and 3-word window.
 *
 * CVs write long and postings write short: cv.md says "Model Quantization" and
 * "Edge / On-Device Deployment"; the market posts "Staff Engineer - Model
 * Quantization" and "Software Engineer, On-Device Intelligence". Only
 * `Quantization` and `On-Device` reach both, and neither is the whole phrase.
 *
 * @param {string} phrase
 * @returns {string[]} longest windows first
 */
export function ngrams(phrase) {
  const out = [];
  // A slash or a parenthetical is an alternation, not part of a name:
  // "Edge / On-Device Deployment" is two claims, and windows spanning the
  // slash ("Edge /", "/ On-Device") are neither. "NPU/GPU Acceleration" splits
  // the same way. Windows never cross these boundaries.
  for (const chunk of String(phrase).split(/\s*[/()]\s*|\s+[·•]\s+/)) {
    // Keep +, #, . and - inside a token: C++, C#, llama.cpp, On-Device.
    const words = chunk.split(/[^A-Za-z0-9+#.-]+/).filter(Boolean);
    for (let n = 3; n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const g = words.slice(i, i + n).join(' ');
        if (n === 1) {
          if (STOPWORDS.has(g.toLowerCase())) continue;
          if (g.length < 2) continue;
          if (!/[A-Za-z]/.test(g)) continue; // "3" out of "E(3) GNNs"
        }
        out.push(g);
      }
    }
  }
  return out;
}

/**
 * Head nouns that are real parts of a title but useless as a keyword ALONE.
 *
 * Every one of these is produced legitimately — `Engineer` from "Machine
 * Learning Engineer", `Data` from "AI Data Specialist" — and every one of them
 * matches most of a job board on its own. They are marked rather than dropped:
 * the caller decides, and a user reviewing the diff can see that the CV really
 * did say it.
 *
 * This is a fixed list, not a frequency threshold. Frequency was tried against
 * 9,661 live titles and could not separate `Specialist` (491 hits, useless)
 * from `Machine Learning` (67 hits, exact) — the two failure modes are not
 * distinguishable by count.
 */
export const GENERIC_ALONE = new Set([
  'engineer', 'engineering', 'developer', 'scientist', 'science', 'analyst',
  'manager', 'specialist', 'assistant', 'associate', 'consultant', 'architect',
  'data', 'model', 'models', 'systems', 'system', 'software', 'technology',
  'learning', 'machine', 'research', 'development', 'design', 'technical',
  'platform', 'product', 'program', 'project', 'solutions', 'services',
  'applied', 'senior', 'staff', 'lead', 'teaching', 'fellow',
]);

/**
 * Read the entries out of one skills section, in whichever of the four shapes
 * it is written.
 *
 *   `**ML Systems & Inference:** LLM Inference, GGUF | Model Serving`
 *   `- Python, C++, SQL`
 *   `Python, C++, SQL`
 *   `| Languages | Python, C++ |`
 *
 * @param {string} body
 * @returns {{label: string, items: string[]}[]} one entry per labelled group;
 *   unlabelled lines are grouped under `''`.
 */
export function readSkills(body) {
  const groups = [];
  const unlabelled = [];
  const split = (s) => s.split(/[,;|]|\s+·\s+|\s+•\s+/).map((x) => x.trim()).filter(Boolean);

  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // Table row: | Label | a, b | — the first cell labels the rest.
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2 && !/^[-: ]+$/.test(cells[0])) {
        groups.push({ label: cells[0].replace(/[*_`]/g, ''), items: cells.slice(1).flatMap(split) });
      }
      continue;
    }

    const bare = line.replace(/^[-*+]\s+/, '');

    // Labelled: **Label:** items  /  **Label**: items  /  Label: items
    //
    // The colon can fall inside or outside the emphasis — `**ML & AI:** …` and
    // `**ML & AI**: …` are both written — so the markers are stripped from both
    // captures rather than positioned in the pattern.
    const labelled = /^\*{0,2}([^:*]{1,40})\*{0,2}\s*:\s*(.+)$/.exec(bare);
    if (labelled) {
      groups.push({
        label: labelled[1].replace(/[*_`]/g, '').trim(),
        items: split(labelled[2].replace(/^[*_`\s]+/, '')),
      });
      continue;
    }

    // Bare list line, bulleted or not.
    unlabelled.push(...split(bare));
  }

  if (unlabelled.length) groups.push({ label: '', items: unlabelled });
  return groups;
}

/**
 * Read job titles out of one experience section.
 *
 * Once the section is known, the title is the head of each entry's own heading
 * or bold line, up to the first separator — CVs punctuate this as `Title —
 * Company`, `Title | Company | Dates`, `Title, Company` or `Title @ Company`,
 * and all four are the same shape. Seniority is stripped: it is already
 * expressed by `title_filter.seniority_boost`, and as a keyword it would only
 * narrow the search.
 *
 * Companies are returned alongside, not discarded: an employer's name repeats
 * through the bullets ("Axiado's NPU silicon", "on-silicon") and the repetition
 * rule below would otherwise promote it to a keyword. It is mechanically
 * identifiable here — it is what sits on the other side of the separator — so
 * it never has to be guessed at or listed by hand.
 *
 * @param {string} body
 * @returns {{titles: string[], companies: string[]}}
 */
export function readRoleTitles(body) {
  const titles = [];
  const companies = [];
  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // An entry heading (### …) or a bold line (**…**) — the two ways a CV
    // marks "this is a position", both stripped of their markers.
    const m = /^#{1,6}\s+(.+)$/.exec(line) ?? /^\*\*(.+?)\*\*/.exec(line);
    if (!m) continue;

    const parts = m[1].replace(/[*_`]/g, '').split(/\s+[—–|@]\s+|\s+-\s+|,/);
    const head = parts[0].trim();
    if (!head) continue;

    for (const rest of parts.slice(1)) {
      const c = rest.trim();
      if (c && /[A-Za-z]/.test(c)) companies.push(c);
    }

    const title = head.replace(SENIORITY_PREFIX, '').replace(SENIORITY_SUFFIX, '').trim();
    if (title && /[A-Za-z]/.test(title)) titles.push(title);
  }
  return { titles, companies };
}

/**
 * Domain vocabulary the Experience BULLETS carry and the Skills list does not.
 *
 * Reading only headings and the skills list left a measurable hole: `Silicon`,
 * `RTL` and `Kernel` are each written plainly in this repo's cv.md — "on custom
 * NPU silicon", "spanning spec, RTL, and DV", "kernel-level tuning" — and each
 * accounted for real postings the derived filter stopped matching (46, 9 and 7
 * respectively in a 543-posting corpus).
 *
 * Prose cannot be mined the way a list can: every sentence yields dozens of
 * n-grams and almost all of them are English. Two rules were measured against
 * this CV's Experience section, and both are kept because they fail
 * differently:
 *
 *   ACRONYM   — an all-caps token. Domain jargon is overwhelmingly written this
 *               way and ordinary prose is not, so precision is high at any
 *               frequency: NPU, GGUF, RTL, DV, LLM, RLHF, CNN. This is the only
 *               rule that catches a term mentioned ONCE, which `RTL` is.
 *   REPEATED  — a lowercase term used at least twice IN THIS SECTION. What
 *               someone actually does gets restated; incidental words do not.
 *               Catches silicon(3), inference(3), quantization(2), kernel(2) —
 *               none of which are capitalized, so no casing rule would.
 *
 * Scoped to Experience and Summary, not the whole file: counting everything
 * pulled in `citations`, `university`, `linkedin`, `scholar` and the contact
 * block, none of which are anything. Summary earns its place — it is the
 * candidate's own one-paragraph positioning, the densest domain vocabulary in
 * the document, and `kernel` reaches its second mention only there.
 *
 * The rules are deliberately loose about noise (`data`, `quality`, `stem`,
 * `UI`). A wrong keyword here is visible in the diff the user confirms, and the
 * head-noun marking plus the model's drop pass both sit downstream. A MISSING
 * keyword is invisible — nothing downstream can recover it.
 *
 * @param {string[]} bodies - Experience (bullets are taken) and Summary (all of
 *   it). Counted together: a term said once in each is said twice.
 * @returns {{term: string, rule: 'acronym'|'repeated', count: number}[]}
 */
export function readExperienceProse(bodies, excludeTerms = []) {
  // Employer names, from the Experience headings. See readRoleTitles.
  const excluded = new Set(
    excludeTerms.flatMap((c) => String(c).toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 2),
  );
  const parts = [];
  for (const [i, body] of bodies.entries()) {
    const lines = String(body ?? '').split(/\r?\n/);
    // Experience (first) contributes its BULLETS only — the paragraphs under a
    // position are usually the company blurb, not the candidate's work. Summary
    // is one paragraph and is taken whole.
    const wanted = i === 0 ? lines.filter((l) => /^\s*[-*+]\s/.test(l)) : lines;
    parts.push(wanted.join(' '));
  }
  const prose = parts.join(' ');
  if (!prose.trim()) return [];

  const out = [];

  for (const a of new Set(prose.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? [])) {
    out.push({ term: a, rule: 'acronym', count: 1 });
  }

  // Whole tokens and hyphen-split stems are counted SEPARATELY. Splitting
  // "large-scale" into `large` and `scale` and then counting them as mentions
  // promotes two prose fragments to keywords on the strength of one compound —
  // measured: `large`, `end` and `scale` all reached the threshold that way and
  // between them matched 9 postings, none relevant. A stem is emitted only when
  // it is ALSO written on its own somewhere ("kernel-level" plus "kernel-"),
  // which is what distinguishes a term the candidate uses from half of a word.
  const whole = new Map();
  const stems = new Map();
  for (const raw of prose.toLowerCase().match(/[a-z][a-z0-9.+-]{2,}/g) ?? []) {
    const w = raw.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
    if (!w) continue;
    whole.set(w, (whole.get(w) ?? 0) + 1);
    if (w.includes('-')) {
      for (const part of w.split('-').filter((x) => x.length > 2)) {
        stems.set(part, (stems.get(part) ?? 0) + 1);
      }
    }
  }
  const counts = new Map(whole);
  for (const [stem, n] of stems) {
    if (!whole.has(stem)) continue; // fragment only — never written alone
    counts.set(stem, (counts.get(stem) ?? 0) + n);
  }

  for (const [term, count] of counts) {
    if (count < 2) continue;
    if (STOPWORDS.has(term) || PROSE_STOPWORDS.has(term)) continue;
    if (excluded.has(term)) continue;
    out.push({ term, rule: 'repeated', count });
  }
  return out;
}

/**
 * Is this keyword a substring of ordinary words rather than a term of its own?
 *
 * `scan.mjs::compileKeyword` word-boundaries a keyword only when it is 2–3
 * characters. At 4 it becomes a plain substring test, and an acronym mined from
 * a CV walks straight into that: `STEM` (from "STEM datasets") matched 51
 * postings in a 510-title corpus and not one of them said STEM — every hit was
 * `Sy·stem·s`, `Sub·system`, `System Software`. The same shape as the upstream
 * bug where `Java` matches "JavaScript Developer" and `APIs` matches "Physical
 * Therapist".
 *
 * Detected, not listed: compare substring hits against word-boundary hits over
 * a corpus of real titles. A genuine term matches about as often either way; a
 * collision matches far more as a substring. This needs no dictionary and no
 * curation, and it works on a corpus biased by the current filter — bias
 * affects WHICH titles are present, not whether "system" contains "stem".
 *
 * @param {string} keyword
 * @param {string[]} corpus - real posting titles
 * @param {number} [ratio] - substring hits this many times the bounded hits
 * @returns {boolean} true when the keyword mostly matches inside other words
 */
export function isSubstringCollision(keyword, corpus, ratio = 3) {
  const k = String(keyword).toLowerCase();
  if (k.length <= 3) return false; // compileKeyword already bounds these
  if (!/^[a-z0-9]+$/.test(k)) return false; // multi-word or punctuated: not the failure mode
  const bounded = new RegExp(`\\b${k}\\b`);
  let sub = 0;
  let whole = 0;
  for (const t of corpus) {
    const lower = String(t).toLowerCase();
    if (!lower.includes(k)) continue;
    sub++;
    if (bounded.test(lower)) whole++;
  }
  if (sub < 3) return false; // too little evidence to call it
  return sub >= whole * ratio;
}

/**
 * Verbs and structure words a CV's bullets repeat because of how bullets are
 * written, not because of what the candidate does. Only needed for the prose
 * rule — a Skills list never contains them.
 */
const PROSE_STOPWORDS = new Set([
  'across', 'their', 'they', 'this', 'have', 'been', 'more', 'than', 'also', 'each', 'such',
  'very', 'when', 'them', 'using', 'used', 'other', 'some', 'only', 'both', 'will', 'can',
  'are', 'was', 'were', 'with', 'team', 'teams', 'work', 'works', 'role', 'year', 'years',
  'level', 'time', 'full', 'into', 'that', 'from', 'and', 'the', 'for',
  'define', 'defined', 'tracked', 'spanning', 'bring', 'built', 'trained', 'managed',
  'developed', 'engineered', 'partner', 'profile', 'optimize', 'curate', 'evaluate',
  'deliver', 'improve', 'improving', 'reduce', 'increase', 'locate', 'implement',
  'integrate', 'integrated', 'establish', 'establishing', 'quantify', 'raise', 'cutting',
  'achieving', 'enforcing', 'annotate', 'deploy', 'deployed', 'deploying', 'tuning',
  'multi', 'consistency', 'measurement', 'frameworks', 'quality', 'accuracy', 'depth',
]);

/**
 * Everything the CV offers, tagged by where it came from.
 *
 * Provenance is part of the output, not a debugging aid: a keyword the user is
 * asked to confirm is only reviewable if they can see the line it came from.
 *
 * @param {string} markdown - cv.md contents.
 * @returns {{roles: string[], domain: {label: string, items: string[]}[], tools: {label: string, items: string[]}[], prose: {term: string, rule: string, count: number}[], skippedSections: string[]}}
 */
export function readCv(markdown) {
  const roles = [];
  const domain = [];
  const tools = [];
  const prose = [];
  const skippedSections = [];
  const employers = [];
  let experienceBody = '';
  let summaryBody = '';

  for (const section of splitCvSections(markdown)) {
    const key = looseSectionKey(section.key);
    if (key === 'summary') { summaryBody = section.body; continue; }
    if (!READ_SECTIONS.has(key)) {
      if (section.title) skippedSections.push(section.title);
      continue;
    }
    if (key === 'experience') {
      const { titles, companies } = readRoleTitles(section.body);
      roles.push(...titles);
      employers.push(...companies);
      experienceBody = section.body;
      continue;
    }
    for (const group of readSkills(section.body)) {
      (TOOL_LABEL.test(group.label) ? tools : domain).push(group);
    }
  }

  prose.push(...readExperienceProse([experienceBody, summaryBody], employers));
  return { roles, domain, tools, prose, skippedSections };
}

/**
 * The full mechanical pass: cv.md in, candidate keywords out.
 *
 * Deterministic — the same file always yields the same list, which is the
 * property the model-driven path cannot offer (two runs of the same prompt on
 * this CV returned 19 keywords and 12).
 *
 * Nothing is scored or ranked here. Choosing among candidates needs either the
 * user or a model, and pretending otherwise is what produced a shortlist led by
 * `Specialist` and `Assistant`.
 *
 * @param {string} markdown
 * @returns {{keyword: string, words: number, generic: boolean, source: string, from: string}[]}
 *   de-duplicated, longest-window-first within each source phrase. `generic`
 *   marks a bare head noun (see GENERIC_ALONE) — true means "the CV really says
 *   this, but it is not a filter on its own".
 */
export function deriveKeywords(markdown, opts = {}) {
  const corpus = Array.isArray(opts.corpus) ? opts.corpus : [];
  const { roles, domain, prose } = readCv(markdown);
  const out = [];
  const seen = new Set();

  const add = (keyword, source, from) => {
    const key = keyword.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // A keyword that only ever matches inside other words is not narrower, it
    // is wrong — it admits a class of postings that never mentioned it. Dropped
    // rather than marked: unlike a bare head noun, there is no reading under
    // which the user meant it.
    if (corpus.length && isSubstringCollision(keyword, corpus)) return;
    const words = keyword.split(' ').length;
    out.push({ keyword, words, generic: words === 1 && GENERIC_ALONE.has(key), source, from });
  };

  for (const title of roles) {
    for (const g of ngrams(title)) add(g, 'experience', title);
  }
  for (const p of prose) {
    for (const g of ngrams(p.term)) add(g, `experience-prose:${p.rule}`, p.term);
  }
  for (const group of domain) {
    for (const item of group.items) {
      for (const g of ngrams(item)) add(g, 'skills', `${group.label ? `${group.label}: ` : ''}${item}`);
    }
    // The category label is itself a claim — "ML Systems & Inference" is where
    // `ML Systems` and `Inference` come from, and neither appears in any item.
    for (const part of group.label.split('&')) {
      for (const g of ngrams(part)) add(g, 'skills-label', group.label);
    }
  }
  return out;
}

/**
 * Does keyword `broad` make keyword `narrow` unable to match anything new?
 *
 * Under `scan.mjs::compileKeyword`, a keyword of 4+ characters is a plain
 * case-insensitive substring test. So if `broad` is a substring of `narrow`,
 * every title containing `narrow` also contains `broad`: keeping both is
 * keeping one. `LLM Inference Optimization` can never admit a posting that
 * `Inference` does not.
 *
 * A 2–3 character keyword is matched with word boundaries instead, and that
 * breaks the implication — so short keywords never subsume. `ML` does NOT
 * subsume `ML Systems`: the title "HTML Systems Engineer" contains the
 * substring "ML Systems", but `\bml\b` does not match it.
 *
 * That case is the reason this is computed from compileKeyword's rule rather
 * than probed with sample titles. A probe over invented titles reported `ML
 * Systems ⊂ ML`, `LLM Inference ⊂ LLM` and `AI Data ⊂ AI` — all false, and all
 * false in the direction that silently discards a keyword.
 *
 * @param {string} broad
 * @param {string} narrow
 * @returns {boolean}
 */
export function subsumes(broad, narrow) {
  const b = String(broad).toLowerCase();
  const nk = String(narrow).toLowerCase();
  if (b === nk) return false;
  if (b.length <= 3) return false; // word-bounded: containment does not carry
  return nk.includes(b);
}

/**
 * Group keywords that cannot both earn their place.
 *
 * Each group is one broader keyword and the narrower ones it already covers.
 * Which to keep is NOT decided here: it is a precision/recall call that goes
 * both ways. `Machine Learning` is the better keeper over `Machine Learning
 * Engineer` (broader, still on-target), while `Model Serving` is the better
 * keeper over `Serving` (which matches food service). Only the fact that a
 * choice exists is mechanical.
 *
 * @param {string[]} keywords
 * @returns {{broad: string, covers: string[]}[]} broadest-first
 */
export function redundancyGroups(keywords) {
  const list = [...new Set(keywords)];
  const groups = [];
  for (const broad of list) {
    const covers = list.filter((narrow) => subsumes(broad, narrow));
    if (covers.length) groups.push({ broad, covers });
  }
  return groups.sort((a, b) => b.covers.length - a.covers.length || a.broad.length - b.broad.length);
}

/**
 * Which of a current `title_filter.positive` the CV does not support.
 *
 * The half that `modes/titles.md` cannot do — it only ever adds, so a templated
 * or hand-typed list survives every future run. Removal has to be mechanical:
 * it is the operation that must give the same answer twice.
 *
 * A keyword counts as supported when it appears, case-insensitively, in ANY
 * candidate the CV produced, or contains one. `Inference` supports
 * `LLM Inference`, and `Machine Learning` supports `Machine`.
 *
 * @param {string[]} current
 * @param {{keyword: string}[]} derived - output of deriveKeywords()
 * @returns {string[]} keywords with no CV support, in their original order
 */
export function unsupportedByCv(current, derived) {
  const have = derived.map((d) => d.keyword.toLowerCase());
  return (current ?? []).filter((k) => {
    const lower = String(k).toLowerCase();
    return !have.some((h) => h === lower || h.includes(lower) || lower.includes(h));
  });
}

/**
 * The target vocabulary the user has already written down, from
 * `modes/_profile.md`'s "Your Target Roles" table.
 *
 * That file is the user layer's statement of what they are actually hunting —
 * archetype names in the first column, the technologies and axes that define
 * each in the second. It is CV-derived (its own header says "Every claim below
 * traces to cv.md or config/profile.yml") but it carries something cv.md does
 * not: which parts of the CV are the TARGET. A CV lists every job someone has
 * held; a target list says which of them they want more of.
 *
 * That distinction is what the extractor cannot get from cv.md alone. This
 * repo's CV has five positions, three of them academic or part-time
 * (postdoc, teaching fellow, data-annotation contract). Extraction correctly
 * yields `Teaching Fellow` and `Data Specialist`; only `_profile.md` says they
 * are not the target.
 *
 * Parsed structurally — table rows under the Target Roles heading, both the
 * archetype cell and the axes cell — so a user who edits their archetypes
 * changes the filter without touching anything else.
 *
 * @param {string} md - modes/_profile.md contents.
 * @returns {{archetypes: string[], axes: string[]}}
 */
export function readTargetRoles(md) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,4}\s.*target roles/i.test(l));
  if (start < 0) return { archetypes: [], axes: [] };

  const archetypes = [];
  const axes = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,4}\s/.test(l)) break;                       // next section
    if (!l.trim().startsWith('|')) continue;
    const cells = l.trim().slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^[-: ]+$/.test(cells[0])) continue;               // separator row
    if (/^archetype$/i.test(cells[0].replace(/[*_`]/g, ''))) continue; // header
    // Parentheticals and stretch markers are annotation, not vocabulary.
    const name = cells[0].replace(/[*_`]/g, '').replace(/\((?:[^)]*)\)/g, ' ').trim();
    if (name) archetypes.push(name);
    if (cells[1]) axes.push(cells[1].replace(/[*_`]/g, '').trim());
  }
  return { archetypes, axes };
}

/**
 * The individual words the target vocabulary is made of, lowercased.
 *
 * Used two ways, both of which need words rather than phrases: deciding whether
 * a CV-derived keyword is on-target at all, and choosing which side of a
 * redundancy pair to keep.
 *
 * @param {{archetypes: string[], axes: string[]}} target
 * @returns {Set<string>}
 */
export function targetVocabulary(target) {
  const words = new Set();
  for (const phrase of [...(target.archetypes ?? []), ...(target.axes ?? [])]) {
    for (const w of String(phrase).toLowerCase().split(/[^a-z0-9.+-]+/)) {
      const t = w.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
      if (t.length > 1 && !STOPWORDS.has(t)) words.add(t);
      if (t.includes('-')) for (const part of t.split('-')) if (part.length > 2) words.add(part);
    }
  }
  return words;
}

/**
 * Is this keyword part of what the user says they are hunting?
 *
 * True when any word of the keyword appears in the target vocabulary. Word-level
 * rather than phrase-level on purpose: the market's phrasing will not match the
 * user's, and requiring it to would reject `Quantization` because `_profile.md`
 * writes "quantization, operator scheduling".
 *
 * Fails OPEN — with no target file, everything is on-target. This is a filter on
 * a proposal the user still confirms, so a missing profile should narrow nothing.
 *
 * @param {string} keyword
 * @param {Set<string>} vocabulary
 * @returns {boolean}
 */
export function isOnTarget(keyword, vocabulary) {
  if (!vocabulary || vocabulary.size === 0) return true;
  return String(keyword)
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter(Boolean)
    .some((w) => vocabulary.has(w));
}
