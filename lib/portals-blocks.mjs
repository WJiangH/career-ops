// lib/portals-blocks.mjs — textual edits to portals.yml's title_filter lists.
//
// portals.yml is a USER-LAYER file (DATA_CONTRACT). A js-yaml parse-and-dump
// round-trip would be shorter and would destroy every comment in it — the
// ones recording WHY a keyword or company is there, which a user cannot
// reconstruct. So the two lists a tool may own (`title_filter.positive`,
// `title_filter.negative`) are replaced or extended textually, and every other
// byte — `tracked_companies` above all, which has no derivation path anywhere
// in the repo — comes back identical.
//
// Shared by titles-derive.mjs and titles-suggest.mjs so the two cannot drift
// on what "replace the keyword block" means.

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LIST_KEYS = new Set(['positive', 'negative']);

/**
 * Locate `title_filter.<key>:` and the extent of its list.
 * @returns {{ start: number, end: number, indent: number, lines: string[] }}
 */
function locate(src, key) {
  if (!LIST_KEYS.has(key)) throw new Error(`unsupported title_filter key: ${key}`);
  const lines = src.split(/\r?\n/);
  const tf = lines.findIndex((l) => /^title_filter:\s*$/.test(l));
  if (tf < 0) throw new Error('portals.yml has no top-level title_filter: block');

  let start = -1;
  for (let i = tf + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;                       // left title_filter entirely
    if (new RegExp(`^\\s+${key}:\\s*$`).test(lines[i])) { start = i; break; }
  }
  if (start < 0) throw new Error(`portals.yml has no title_filter.${key}: block`);

  // The block ends at the next non-blank line at the key's indent or shallower —
  // the next sibling key (`negative:`, `seniority_boost:`) or the next top-level key.
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = (l.match(/^\s*/) ?? [''])[0].length;
    if (ind <= indent) { end = i; break; }
  }
  return { start, end, indent, lines };
}

/** Existing list items of a block, unquoted. */
export function readListBlock(src, key) {
  const { start, end, lines } = locate(src, key);
  const out = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^\s*-\s+(.+?)\s*$/);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try { v = JSON.parse(v.startsWith("'") ? `"${v.slice(1, -1)}"` : v); } catch { v = v.slice(1, -1); }
    }
    out.push(v);
  }
  return out;
}

/**
 * Replace the whole list under `title_filter.<key>` with `items`, optionally
 * prefixed by comment lines explaining where they came from.
 */
export function replaceListBlock(src, key, items, comments = []) {
  const { start, end, indent, lines } = locate(src, key);
  const pad = ' '.repeat(indent);
  const body = [
    ...comments.map((c) => `${pad}  # ${c}`),
    ...items.map((k) => `${pad}  - ${JSON.stringify(k)}`),
  ];
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

/**
 * Append `items` to `title_filter.<key>` that are not already present
 * (case-insensitive), keeping every existing entry and comment in place.
 * Returns { text, added }.
 */
export function appendToListBlock(src, key, items, comments = []) {
  const existing = new Set(readListBlock(src, key).map((k) => k.toLowerCase()));
  const added = [];
  for (const k of items) {
    const kk = String(k).trim();
    if (!kk || existing.has(kk.toLowerCase())) continue;
    existing.add(kk.toLowerCase());
    added.push(kk);
  }
  if (!added.length) return { text: src, added };
  const { end, indent, lines } = locate(src, key);
  const pad = ' '.repeat(indent);
  // Insert before the trailing blank lines that separate this block from the next key.
  let at = end;
  while (at > 0 && !lines[at - 1].trim()) at--;
  const body = [
    ...comments.map((c) => `${pad}  # ${c}`),
    ...added.map((k) => `${pad}  - ${JSON.stringify(k)}`),
  ];
  return { text: [...lines.slice(0, at), ...body, ...lines.slice(at)].join('\n'), added };
}

/** Back-compat name used by titles-derive.mjs. */
export function replacePositiveBlock(src, keywords) {
  return replaceListBlock(src, 'positive', keywords, [
    'Derived from cv.md by titles-derive.mjs. Re-run it after a CV change;',
    'hand edits here are kept until the next run proposes a diff over them.',
  ]);
}

export const TEMPLATE_REL = 'templates/portals.example.yml';

/**
 * Day zero: copy the template to portals.yml if none exists. The template is
 * a system-layer file (it ships with the codebase); portals.yml is user-layer
 * (it lives under the data root, which CAREER_OPS_ROOT may point elsewhere).
 * Companies, boards, location and negative filters have no derivation path,
 * so the template is the starting point; only title_filter.* is ever derived.
 * @returns {{ created: boolean, path: string }}
 */
export function scaffoldPortals(dataRoot, codeRoot = dataRoot) {
  const target = join(dataRoot, 'portals.yml');
  if (existsSync(target)) return { created: false, path: target };
  const tpl = join(codeRoot, TEMPLATE_REL);
  if (!existsSync(tpl)) throw new Error(`${TEMPLATE_REL} not found — nothing to scaffold from.`);
  copyFileSync(tpl, target);
  return { created: true, path: target };
}
