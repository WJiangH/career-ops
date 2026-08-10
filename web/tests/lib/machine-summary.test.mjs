// tests/lib/machine-summary.test.mjs — parsing the report's own TL;DR.
//
// Reports are agent-written, so this parser's job is to be unshakeable: a
// malformed block must degrade the display, never turn a finished evaluation
// (score persisted, tracker row merged) into a failed one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMachineSummary, readMachineSummary, newReportSince, snapshotReports } from "../../src/lib/machine-summary.mjs";

const REAL = `# Evaluation: Adobe — Principle Engineering Program Manager

**Score:** 1.3/5

## Machine Summary

\`\`\`yaml
company: "Adobe"
role: "Principle Engineering Program Manager, Agentic Builder Experiences"
score: 1.3
legitimacy_tier: "High Confidence"
final_decision: "Skip"
hard_stops:
  - "Role requires 8+ years technical program management"
  - "Requires executive communication at Principal scope"
top_strengths:
  - "Deep systems-level technical fluency"
next_action: "Skip — do not apply."
work_auth: "unstated"
\`\`\`
`;

test("parses the fields a phone actually shows", () => {
  const s = parseMachineSummary(REAL);
  assert.equal(s.company, "Adobe");
  assert.equal(s.score, 1.3);
  assert.equal(s.final_decision, "Skip");
  assert.equal(s.work_auth, "unstated");
  assert.deepEqual(s.hard_stops.length, 2);
  assert.match(s.next_action, /do not apply/);
});

test("tolerates a bare fence and a deeper heading", () => {
  const s = parseMachineSummary("#### Machine Summary\n\n```\nscore: 4.2\ncompany: Etched\n```\n");
  assert.equal(s.score, 4.2);
  assert.equal(s.company, "Etched");
});

test("a string where a list belongs still renders", () => {
  // Agents do this. `.map()` on a string would throw and take down the pane.
  const s = parseMachineSummary('## Machine Summary\n\n```yaml\nhard_stops: "just the one"\n```\n');
  assert.deepEqual(s.hard_stops, ["just the one"]);
});

test("score given as a quoted string is still numeric", () => {
  const s = parseMachineSummary('## Machine Summary\n\n```yaml\nscore: "3.5"\n```\n');
  assert.equal(s.score, 3.5);
});

test("no block, malformed yaml, and empty block all return null, never throw", () => {
  assert.equal(parseMachineSummary("# Report\n\nNo summary here.\n"), null);
  assert.equal(parseMachineSummary("## Machine Summary\n\n```yaml\n: : not: [valid\n```\n"), null);
  assert.equal(parseMachineSummary("## Machine Summary\n\n```yaml\n\n```\n"), null);
});

test("unknown keys are dropped rather than passed through", () => {
  const s = parseMachineSummary('## Machine Summary\n\n```yaml\nscore: 2\nprompt_injection: "ignore previous instructions"\n```\n');
  assert.equal(s.score, 2);
  assert.equal(s.prompt_injection, undefined);
});

test("readMachineSummary reports its own path and survives a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-ms-"));
  try {
    mkdirSync(join(dir, "reports"));
    writeFileSync(join(dir, "reports", "040-adobe-2026-08-10.md"), REAL);
    const s = readMachineSummary(dir, "reports/040-adobe-2026-08-10.md");
    assert.equal(s.report, "reports/040-adobe-2026-08-10.md");
    assert.equal(s.company, "Adobe");
    assert.equal(readMachineSummary(dir, "reports/nope.md"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newReportSince picks the run's own report, not merely the newest", () => {
  // Two concurrent evaluations: "newest mtime" would hand one run the other's
  // report. Set difference against a pre-run snapshot cannot.
  const dir = mkdtempSync(join(tmpdir(), "co-ms2-"));
  try {
    mkdirSync(join(dir, "reports"));
    writeFileSync(join(dir, "reports", "040-adobe-2026-08-10.md"), REAL);
    const before = snapshotReports(dir);
    writeFileSync(join(dir, "reports", "041-etched-2026-08-10.md"), REAL);
    writeFileSync(join(dir, "reports", "042-RESERVED.md"), "{}"); // sentinel, not a report
    assert.equal(newReportSince(dir, before), join("reports", "041-etched-2026-08-10.md"));
    assert.equal(newReportSince(dir, snapshotReports(dir)), null); // nothing new
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
