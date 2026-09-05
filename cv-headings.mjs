/**
 * cv-headings.mjs — recognize a CV's sections whatever the heading is spelled like.
 *
 * Extracted verbatim from generate-pdf.mjs, which needed it to check that a
 * rendered PDF's section order still matches cv.md's. It is the only
 * format-tolerant reader of cv.md in the repo — any heading level, any
 * indentation, diacritics folded, and an alias table covering the spellings and
 * translations the same section shows up under.
 *
 * It lives here rather than there so a caller can use it WITHOUT pulling in
 * playwright: generate-pdf.mjs imports a browser at module scope, which is
 * right for a PDF renderer and absurd for reading a markdown file. Same
 * extraction, and same reason, as cv-sections-core.mjs pulling the shared
 * section-stripping out of the two CV builders.
 *
 * The alternative — a second copy of the alias table next to the new caller —
 * is the arrangement that produced the profile.yml `target_roles` bug, where a
 * hand-written mirror of providers/_profile-keywords.mjs read both of its
 * fields with the wrong shape and returned [] for years without erroring.
 *
 * generate-pdf.mjs re-exports `sectionKey` so its public surface is unchanged.
 */


/**
 * Strip diacritics so a heading is recognized regardless of how it was typed.
 *
 * Rendered Polish headings are not always spelled with their diacritics —
 * "Wykształcenie" and "Wyksztalcenie" both occur in already-generated CVs.
 * NFD splits most Polish letters into a base plus a combining mark we drop;
 * ł (U+0142) has no canonical decomposition, so it needs its own pass.
 *
 * Only used for alias lookup — display titles keep their diacritics.
 */
function foldDiacritics(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

/**
 * Heading spelling -> canonical section key.
 *
 * Polish (modes/pl) is here because without these aliases the rendered Polish
 * titles match nothing derived from the English cv.md: validateCvSectionOrder()
 * finds fewer than two comparable sections and silently returns, leaving the
 * section-order guard disabled on every CV rendered in that mode.
 *
 * Keys are folded on construction so authored diacritics match stripped input.
 */
const SECTION_ALIASES = new Map([
  // English — cv.md is the source of truth and is written in English.
  ['summary', 'summary'],
  ['professional summary', 'summary'],
  ['competencies', 'competencies'],
  ['core competencies', 'competencies'],
  ['experience', 'experience'],
  ['work experience', 'experience'],
  ['professional experience', 'experience'],
  ['projects', 'projects'],
  ['selected projects', 'projects'],
  ['personal projects', 'projects'],
  ['education', 'education'],
  ['education & certifications', 'education'],
  ['certifications', 'certifications'],
  ['awards', 'awards'],
  ['honors', 'awards'],
  ['honours', 'awards'],
  ['awards & honors', 'awards'],
  ['awards and honors', 'awards'],
  ['honors & awards', 'awards'],
  ['awards & honours', 'awards'],
  ['skills', 'skills'],
  ['technical skills', 'skills'],
  // Polish — the vocabulary documented in modes/pl/README.md, plus the word-order
  // variants that turn up in practice (both "Kompetencje kluczowe" and
  // "Kluczowe kompetencje" are used for the same section).
  ['podsumowanie', 'summary'],
  ['podsumowanie zawodowe', 'summary'],
  ['profil zawodowy', 'summary'],
  ['kompetencje', 'competencies'],
  ['kompetencje kluczowe', 'competencies'],
  ['kluczowe kompetencje', 'competencies'],
  ['doświadczenie', 'experience'],
  ['doświadczenie zawodowe', 'experience'],
  ['przebieg kariery', 'experience'],
  ['projekty', 'projects'],
  ['kluczowe projekty', 'projects'],
  ['wybrane projekty', 'projects'],
  ['wykształcenie', 'education'],
  ['edukacja', 'education'],
  ['wykształcenie i certyfikaty', 'education'],
  ['certyfikaty', 'certifications'],
  ['certyfikaty i szkolenia', 'certifications'],
  ['szkolenia i certyfikaty', 'certifications'],
  ['nagrody', 'awards'],
  ['wyróżnienia', 'awards'],
  ['nagrody i wyróżnienia', 'awards'],
  ['umiejętności', 'skills'],
  ['umiejętności techniczne', 'skills'],
].map(([alias, key]) => [foldDiacritics(alias), key]));

function normalizeSectionTitle(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sectionKey(text) {
  const normalized = foldDiacritics(normalizeSectionTitle(text));
  return SECTION_ALIASES.get(normalized) ?? normalized;
}

/**
 * Markdown ATX heading: any level, up to three leading spaces, optional closing
 * hashes. This is the whole of the format tolerance — a CV is recognized by its
 * HEADINGS, never by a layout assumed of its body.
 */
export const CV_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Split a CV into its sections, keyed canonically, with nesting respected.
 *
 * A section's body runs until the next heading at the SAME level or shallower —
 * so `### Sr. ML Engineer — Axiado` stays inside `## Professional Experience`
 * rather than starting a section of its own. That distinction is the whole
 * point: a CV marks its positions with headings too, and a flat split ends the
 * Experience section at its first entry, handing back an empty body.
 *
 * Only TOP-LEVEL sections are returned (the shallowest heading level actually
 * used, so a CV written entirely in `###` still works). Nested headings stay in
 * their parent's body, where a per-section reader can interpret them knowing
 * what kind of section they are in.
 *
 * A heading matching no alias keeps its normalized text as the key, so an
 * unrecognized section is still returned with its body rather than silently
 * folded into the previous one. Text before the first heading — the name and
 * contact block — comes back under the key `''`.
 *
 * @param {string} markdown
 * @returns {{key: string, title: string, level: number, body: string}[]} in document order
 */
export function splitCvSections(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CV_HEADING_RE.exec(lines[i]);
    if (!m) continue;
    const title = normalizeSectionTitle(m[2]);
    if (!title) continue;
    headings.push({ i, level: m[1].length, title });
  }

  // The document's own top level, not an assumed `##`: `# Name` + `## Skills`
  // and `## Name` + `### Skills` are the same document at a different offset.
  //
  // The shallowest heading is the candidate's NAME — and so sections live one
  // level down — only when it is the first heading, is alone at its level, and
  // is not itself a section name. That last clause is what the alias table is
  // for. Deciding on "alone at its level" alone misreads a CV with exactly one
  // section: `## Experience` is unique at level 2, but it is a section, and
  // treating it as a name makes its own entries the sections.
  const shallowest = headings.length ? Math.min(...headings.map((h) => h.level)) : 0;
  const atTop = headings.filter((h) => h.level === shallowest);
  const deeper = headings.filter((h) => h.level > shallowest);
  const topIsName =
    atTop.length === 1 &&
    headings[0].level === shallowest &&
    SECTION_ALIASES.get(foldDiacritics(atTop[0].title)) === undefined &&
    deeper.length > 0;
  const sectionLevel = topIsName ? Math.min(...deeper.map((h) => h.level)) : shallowest;

  const marks = headings.filter((h) => h.level <= sectionLevel);
  const out = [];

  const preamble = lines.slice(0, marks.length ? marks[0].i : lines.length);
  if (preamble.some((l) => l.trim())) {
    out.push({ key: '', title: '', level: 0, body: preamble.join('\n') });
  }

  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].i + 1;
    const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;
    out.push({
      key: sectionKey(marks[k].title),
      title: marks[k].title,
      level: marks[k].level,
      body: lines.slice(start, end).join('\n'),
    });
  }
  return out;
}

export { foldDiacritics, normalizeSectionTitle, sectionKey, SECTION_ALIASES };
