// Tests for persona-health.mjs — does the search still follow from the CV?
//
// Both failures modelled here have already happened in this repo: a 19-role
// batch scored against the template author's _profile.md while doctor reported
// green, and a CV replaced with nothing re-deriving the search from it.
//
// Run:  node --test tests/lib/persona-health.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { cvFingerprint, personaIssues, personaHealthy } from "../../src/lib/persona-health.mjs";

const CV = "# Jane Doe\n\n## Experience\n- Built an inference runtime\n";
const kinds = (issues) => issues.map((i) => i.kind);

// ── fingerprint ──────────────────────────────────────────────────────────────

test("the same CV fingerprints the same", () => {
  assert.equal(cvFingerprint(CV), cvFingerprint(CV));
});

test("editor churn is not a CV change", () => {
  // Trailing spaces and CRLF differ between editors and platforms; treating
  // them as a content change would fire the warning on a no-op save.
  assert.equal(cvFingerprint(CV), cvFingerprint(CV.replace(/\n/g, "\r\n")));
  assert.equal(cvFingerprint(CV), cvFingerprint(CV.replace(/\n/g, "   \n")));
  assert.equal(cvFingerprint(CV), cvFingerprint(`\n\n${CV}\n\n`));
});

test("a real edit changes the fingerprint", () => {
  assert.notEqual(cvFingerprint(CV), cvFingerprint(`${CV}- Shipped a CUDA kernel\n`));
});

test("no CV has no fingerprint", () => {
  for (const empty of ["", "   \n\n", null, undefined]) assert.equal(cvFingerprint(empty), "");
});

// ── issues ───────────────────────────────────────────────────────────────────

test("no CV yet is onboarding, not drift", () => {
  // The run route already refuses to evaluate without a CV. Telling someone who
  // has not started that their persona is stale is noise.
  const issues = personaIssues({ cv: "", reviewedFingerprint: null, unpersonalized: [{ path: "modes/_profile.md" }] });
  assert.deepEqual(issues, []);
  assert.ok(personaHealthy(issues));
});

test("a reviewed, unchanged CV with a real profile is healthy", () => {
  const issues = personaIssues({ cv: CV, reviewedFingerprint: cvFingerprint(CV), unpersonalized: [] });
  assert.ok(personaHealthy(issues));
});

test("a CV that has never been reviewed is flagged", () => {
  assert.deepEqual(kinds(personaIssues({ cv: CV, reviewedFingerprint: null })), ["never-reviewed"]);
});

test("a CV edited after the last review is flagged stale", () => {
  const issues = personaIssues({ cv: `${CV}- New role\n`, reviewedFingerprint: cvFingerprint(CV) });
  assert.deepEqual(kinds(issues), ["stale-cv"]);
});

test("stale and never-reviewed are mutually exclusive", () => {
  // One is "you have not done this yet", the other "you did, and it moved".
  // Reporting both would read as two separate problems.
  for (const fp of [null, cvFingerprint("something else")]) {
    assert.equal(personaIssues({ cv: CV, reviewedFingerprint: fp }).length, 1);
  }
});

test("a template _profile.md is a blocker, and carries doctor's own impact text", () => {
  const issues = personaIssues({
    cv: CV,
    reviewedFingerprint: cvFingerprint(CV),
    unpersonalized: [{ path: "modes/_profile.md", reason: "identical to template", impact: "scored against the template author" }],
  });
  assert.deepEqual(kinds(issues), ["template-profile"]);
  assert.equal(issues[0].severity, "blocker");
  assert.match(issues[0].title, /modes\/_profile\.md/);
  assert.equal(issues[0].detail, "scored against the template author", "doctor's wording, not a second copy of it");
});

test("a template file with no impact text still says why it matters", () => {
  const [issue] = personaIssues({ cv: CV, reviewedFingerprint: cvFingerprint(CV), unpersonalized: [{ path: "modes/_brief.md" }] });
  assert.ok(issue.detail.length > 20, "an empty detail would leave the banner meaningless");
});

test("blockers come before warnings", () => {
  const issues = personaIssues({
    cv: CV,
    reviewedFingerprint: null,
    unpersonalized: [{ path: "modes/_profile.md" }],
  });
  assert.deepEqual(kinds(issues), ["template-profile", "never-reviewed"]);
  assert.equal(issues[0].severity, "blocker");
});

test("every reported template file gets its own issue", () => {
  const issues = personaIssues({
    cv: CV,
    reviewedFingerprint: cvFingerprint(CV),
    unpersonalized: [{ path: "modes/_profile.md" }, { path: "modes/_brief.md" }],
  });
  assert.equal(issues.length, 2);
});

test("a missing unpersonalized list is not an error", () => {
  // doctor.mjs can be absent (data-only CAREER_OPS_ROOT) or fail; the drift
  // checks we can still answer must not be lost with it.
  assert.deepEqual(kinds(personaIssues({ cv: CV, reviewedFingerprint: null })), ["never-reviewed"]);
});
