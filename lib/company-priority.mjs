// lib/company-priority.mjs — which dataset companies a capped reverse-ATS scan
// should look at first.
//
// scan-ats-full.mjs samples the first `--limit` companies of each public ATS
// directory, which is alphabetical: with a 150 cap on a 12,884-board Workday
// list that is the "a…" boards and nothing else, and it has no relation to the
// user's targets. `--prefer-known` replaces that with: companies the user has
// already shown interest in first, then a random fill up to the cap.
//
// "Known" means a board we already have evidence for:
//   - portals.yml tracked_companies (the user's curated list), and
//   - any company that already produced a posting in data/scan-history.tsv
//     (it passed the title/location filters once, so it hires for this profile).
// Both are reduced to the same key the datasets use: the ATS slug (greenhouse /
// lever / ashby) or the tenant (workday).
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { loadYaml } from './yaml-document.mjs';
import { parseScanHistoryLine } from './scan-history-columns.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

/** Lowercase, alphanumerics only — the fallback key for a bare company name. */
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract the dataset key from a careers/API/posting URL, or null when the URL
 * is not one of the four ATS hosts the dataset covers.
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function slugFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);

  // Workday: {tenant}.{wdN}.myworkdayjobs.com
  const wd = host.match(/^([a-z0-9-]+)\.wd[\w-]*\.myworkdayjobs\.com$/);
  if (wd) return wd[1];

  // Greenhouse: boards.greenhouse.io/{slug}, job-boards[.eu].greenhouse.io/{slug},
  // boards-api.greenhouse.io/v1/boards/{slug}/jobs
  if (host === 'boards-api.greenhouse.io') {
    const i = seg.indexOf('boards');
    return i >= 0 && seg[i + 1] ? seg[i + 1].toLowerCase() : null;
  }
  if (/(^|\.)greenhouse\.io$/.test(host)) return seg[0] ? seg[0].toLowerCase() : null;

  // Lever: jobs.lever.co/{slug}, api.lever.co/v0/postings/{slug}
  if (host === 'api.lever.co') {
    const i = seg.indexOf('postings');
    return i >= 0 && seg[i + 1] ? seg[i + 1].toLowerCase() : null;
  }
  if (/(^|\.)lever\.co$/.test(host)) return seg[0] ? seg[0].toLowerCase() : null;

  // Ashby: jobs.ashbyhq.com/{slug}, api.ashbyhq.com/posting-api/job-board/{slug}
  if (host === 'api.ashbyhq.com') {
    const i = seg.indexOf('job-board');
    return i >= 0 && seg[i + 1] ? seg[i + 1].toLowerCase() : null;
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) return seg[0] ? seg[0].toLowerCase() : null;

  return null;
}

/**
 * Collect the keys of companies the user already cares about.
 *
 * Best-effort by design: a missing or unreadable file contributes nothing,
 * because the worst outcome of an empty set is the plain random sample.
 *
 * @param {string} [root] career-ops root (defaults to getCareerOpsRoot()).
 * @returns {Set<string>}
 */
const CONFIG_REJECTIONS = new Set(['skipped_title', 'skipped_location', 'skipped_age']);

export function loadKnownCompanies(root = getCareerOpsRoot()) {
  const known = new Set();

  try {
    const portals = path.join(root, 'portals.yml');
    if (existsSync(portals)) {
      const cfg = loadYaml(readFileSync(portals, 'utf-8'));
      for (const c of Array.isArray(cfg?.tracked_companies) ? cfg.tracked_companies : []) {
        if (!c || typeof c !== 'object' || c.enabled === false) continue;
        const slug = slugFromUrl(c.api) || slugFromUrl(c.careers_url);
        if (slug) known.add(slug);
        const key = nameKey(c.name);
        if (key) known.add(key);
      }
    }
  } catch { /* unreadable portals.yml → no tracked companies */ }

  try {
    const history = path.join(root, 'data', 'scan-history.tsv');
    if (existsSync(history)) {
      const lines = readFileSync(history, 'utf-8').split('\n');
      if (lines[0]?.startsWith('url\t')) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        const { url, status } = parseScanHistoryLine(line);
        // The scanner also records what the title, location and age filters
        // dropped. Those rows say the company posted something off-profile, not
        // that it hires for this one.
        if (CONFIG_REJECTIONS.has(status)) continue;
        const slug = slugFromUrl(url);
        if (slug) known.add(slug);
      }
    }
  } catch { /* unreadable history → no history-derived companies */ }

  return known;
}

/** The key a dataset entry is matched on: a slug, or the tenant of a `tenant|instance|site` triple. */
export function datasetKey(entry) {
  return String(entry).split('|')[0].toLowerCase();
}

/**
 * Cap-aware sampling that puts known companies first.
 *
 * Known companies keep the dataset's own order (they are few, and all of them
 * fit under any realistic cap); the rest of the cap is filled with a uniform
 * random sample. Pure apart from `rng`; never mutates `list`.
 *
 * @param {string[]} list dataset entries
 * @param {number} limit max companies to return (Infinity = all)
 * @param {Set<string>} known keys from loadKnownCompanies()
 * @param {() => number} [rng] injectable for tests
 * @returns {string[]}
 */
export function sampleWithPriority(list, limit, known, rng = Math.random) {
  const first = [];
  const rest = [];
  for (const entry of list) (known.has(datasetKey(entry)) ? first : rest).push(entry);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first.concat(rest).slice(0, limit);
}
