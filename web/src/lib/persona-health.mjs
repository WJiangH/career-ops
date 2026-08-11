/**
 * persona-health.mjs — is the search still derived from the CV on file?
 *
 * career-ops scores every offer against a persona: `modes/_profile.md` (target
 * roles, North Star, deal-breakers) and `portals.yml`'s `title_filter`. Both are
 * meant to come from the CV. Nothing enforces that, and two ways of drifting
 * apart have already happened:
 *
 *   1. `_profile.md` never personalized. doctor auto-copies it from the
 *      template, so the existence check passes and onboardingNeeded is false —
 *      while every A–F evaluation is scored against the TEMPLATE AUTHOR's
 *      archetypes. A whole 19-role batch went out that way before anyone
 *      noticed; the dashboard was green throughout.
 *   2. CV replaced, persona not revisited. Adding a CV writes cv.md and stops
 *      there: nothing re-runs `titles`, nothing revisits `_profile.md`. The
 *      search keeps hunting for the previous CV's roles, silently.
 *
 * Detection, not correction. `modes/titles.md` writes keywords only after an
 * explicit confirmed diff, and `_profile.md` holds judgement calls no
 * fingerprint can regenerate. So this reports and links; it never rewrites.
 *
 * Staleness is COMPUTED, not tracked: the recorded fingerprint is compared
 * against the current cv.md on every check. That means no write hook is needed
 * anywhere — saving a new CV makes the persona stale by construction, and no
 * code path can forget to mark it.
 */

import { createHash } from 'node:crypto';

/**
 * Content hash of a CV, insensitive to trailing-whitespace churn from editors.
 *
 * @param {string} text
 * @returns {string} 16 hex chars, or '' for empty input.
 */
export function cvFingerprint(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!normalized) return '';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * @typedef {Object} PersonaIssue
 * @property {'template-profile'|'never-reviewed'|'stale-cv'} kind
 * @property {'blocker'|'warning'} severity
 * @property {string} title
 * @property {string} detail
 */

/**
 * What is wrong with the persona right now.
 *
 * @param {Object} input
 * @param {string} input.cv - Current cv.md contents ('' when absent).
 * @param {string|null} input.reviewedFingerprint - Fingerprint recorded at the last review.
 * @param {{path: string, reason?: string, impact?: string}[]} [input.unpersonalized]
 *   doctor --json's `unpersonalized` array, passed through rather than
 *   recomputed — doctor owns that comparison and already has tests for it.
 * @returns {PersonaIssue[]} Most severe first; empty means healthy.
 */
export function personaIssues({ cv, reviewedFingerprint, unpersonalized = [] }) {
  /** @type {PersonaIssue[]} */
  const issues = [];
  const current = cvFingerprint(cv);

  // No CV is an onboarding state, not a drift problem — the run route already
  // refuses to evaluate without one, and saying "your persona is stale" to
  // someone who has not started is noise.
  if (!current) return issues;

  for (const u of unpersonalized) {
    // _custom.md is deliberately exempt upstream (optional house rules, valid
    // to ship unedited), so anything doctor reports here is worth surfacing.
    issues.push({
      kind: 'template-profile',
      severity: 'blocker',
      title: `${u.path} still holds template content`,
      detail: u.impact
        || 'Evaluations are scored against the template author\'s targeting, not yours.',
    });
  }

  if (!reviewedFingerprint) {
    issues.push({
      kind: 'never-reviewed',
      severity: 'warning',
      title: 'Search keywords have never been checked against this CV',
      detail:
        'portals.yml decides which postings are ever seen. Run the titles mode to '
        + 'propose keywords from the CV — it shows a diff and writes nothing without confirmation.',
    });
  } else if (reviewedFingerprint !== current) {
    issues.push({
      kind: 'stale-cv',
      severity: 'warning',
      title: 'The CV changed after the search was last tuned',
      detail:
        'Keywords and target roles still describe the previous CV, so the scanner may be '
        + 'hunting for roles this one no longer supports — and missing ones it now does.',
    });
  }

  return issues;
}

/** True when nothing needs the user's attention. */
export function personaHealthy(issues) {
  return Array.isArray(issues) && issues.length === 0;
}
