// Parse the `## Machine Summary` YAML block that every evaluation report ends
// with (see modes/oferta.md). This is the report's own TL;DR — structured, not
// prose — and it is what a phone should show when a run finishes.
//
// Without it the run pane showed the agent's inter-tool narration ("Now let's
// release the reservation, write the tracker TSV, and merge.") because the
// client displayed the tail of the text stream. The actual product was never in
// that stream at all: the agent Writes it to reports/{num}-{slug}-{date}.md.

import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

/**
 * @typedef {object} MachineSummary
 * @property {string} [company]
 * @property {string} [role]
 * @property {number} [score]
 * @property {string} [legitimacy_tier]
 * @property {string} [archetype]
 * @property {string} [final_decision]
 * @property {string[]} [hard_stops]
 * @property {string[]} [soft_gaps]
 * @property {string[]} [top_strengths]
 * @property {string} [risk_level]
 * @property {string} [confidence]
 * @property {string} [next_action]
 * @property {string} [work_auth]
 * @property {string} [report] Path relative to the career-ops root, so the UI can link to the full report.
 */


const STR_KEYS = ["company", "role", "legitimacy_tier", "archetype", "final_decision", "risk_level", "confidence", "next_action", "work_auth"];
const LIST_KEYS = ["hard_stops", "soft_gaps", "top_strengths"];

/**
 * Pull the Machine Summary out of a report's markdown.
 *
 * Returns null rather than throwing: a report whose block is missing or
 * malformed must still count as a completed run — the score and the tracker row
 * are already persisted, and losing the summary should degrade the display, not
 * turn a successful evaluation into a failure.
 */
/** @param {string} markdown @returns {MachineSummary|null} */
export function parseMachineSummary(markdown) {
  // Tolerate "## Machine Summary" at any heading depth and an optional
  // language tag on the fence; oferta.md specifies ```yaml but reports are
  // agent-written and drift.
  const m = markdown.match(/#{1,4}\s*Machine Summary\s*\n+```[a-zA-Z]*\n([\s\S]*?)\n```/);
  if (!m) return null;

  let doc;
  try {
    doc = yaml.load(m[1]);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const raw = doc;

  // Copy only known keys, coercing shapes. An agent that emits a bare string
  // where a list belongs (it happens) should still render, not blow up a map().
  /** @type {MachineSummary} */
  const out = {};
  for (const k of STR_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  for (const k of LIST_KEYS) {
    const v = raw[k];
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string" && x.trim() !== "");
    else if (typeof v === "string" && v.trim()) out[k] = [v.trim()];
  }
  const score = typeof raw.score === "number" ? raw.score : Number(raw.score);
  if (Number.isFinite(score)) out.score = score;

  return Object.keys(out).length > 0 ? out : null;
}

/** Read + parse a report file. Never throws. */
/** @param {string} root @param {string} relPath @returns {MachineSummary|null} */
export function readMachineSummary(root, relPath) {
  try {
    const s = parseMachineSummary(fs.readFileSync(path.join(root, relPath), "utf8"));
    return s ? { ...s, report: relPath } : null;
  } catch {
    return null;
  }
}

/**
 * The report file an evaluation just produced.
 *
 * Identified by set difference against a snapshot taken before the agent ran,
 * not by "newest mtime": two evaluations can run concurrently, and picking the
 * newest would hand one run the other's summary.
 */
/** @param {string} root @param {Set<string>} before @returns {string|null} */
export function newReportSince(root, before) {
  let names;
  try {
    names = fs.readdirSync(path.join(root, "reports")).filter((f) => f.endsWith(".md") && !f.includes("RESERVED"));
  } catch {
    return null;
  }
  const added = names.filter((n) => !before.has(n));
  if (added.length === 0) return null;
  added.sort(); // deterministic when an agent somehow wrote more than one
  return path.join("reports", added[added.length - 1]);
}

/** Snapshot of reports/ for `newReportSince` to diff against. */
/** @param {string} root @returns {Set<string>} */
export function snapshotReports(root) {
  try {
    return new Set(fs.readdirSync(path.join(root, "reports")).filter((f) => f.endsWith(".md") && !f.includes("RESERVED")));
  } catch {
    return new Set();
  }
}
