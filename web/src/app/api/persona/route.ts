import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { careerOpsRoot } from "@/lib/career-ops";
import { cvFingerprint, personaIssues } from "@/lib/persona-health.mjs";

const run = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the last review is recorded. Web runtime state, gitignored. */
function statePath() {
  return path.join(careerOpsRoot(), ".career-ops-web", "persona.json");
}

function readCv(): string {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), "cv.md"), "utf8");
  } catch {
    return "";
  }
}

function readReviewed(): string | null {
  try {
    const doc = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return typeof doc?.cvFingerprint === "string" ? doc.cvFingerprint : null;
  } catch {
    return null; // never reviewed, or a half-written file — both mean "unknown"
  }
}

/**
 * doctor's own `unpersonalized` verdict, asked for ONCE here rather than at the
 * head of every agent run (where it used to cost a shell-out per evaluation and
 * told a human nothing, because no human was watching). doctor owns that
 * comparison and is tested on it; duplicating the logic in the web layer would
 * be a second source of truth for the same question.
 */
async function unpersonalizedFromDoctor(): Promise<{ path: string; impact?: string }[]> {
  try {
    const { stdout } = await run(process.execPath, ["doctor.mjs", "--json"], {
      cwd: careerOpsRoot(),
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const doc = JSON.parse(stdout);
    return Array.isArray(doc?.unpersonalized) ? doc.unpersonalized : [];
  } catch {
    // A checkout without doctor.mjs, or a doctor that failed: report the drift
    // checks we CAN answer rather than failing the whole endpoint. Claiming
    // "no template problems" would be worse than staying quiet about them.
    return [];
  }
}

export async function GET() {
  const cv = readCv();
  const issues = personaIssues({
    cv,
    reviewedFingerprint: readReviewed(),
    unpersonalized: await unpersonalizedFromDoctor(),
  });
  return NextResponse.json({ issues, hasCv: !!cv.trim() });
}

/**
 * Record that the persona has been reviewed against the CV on file.
 *
 * Deliberately a separate, explicit action rather than a side effect of saving
 * a CV: the point of the check is that a new CV needs a fresh look at the
 * search, so the save itself must never be what clears the warning.
 */
export async function POST() {
  const fingerprint = cvFingerprint(readCv());
  if (!fingerprint) {
    return NextResponse.json({ error: "No CV on file to review against." }, { status: 400 });
  }
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(
      statePath(),
      `${JSON.stringify({ cvFingerprint: fingerprint, reviewedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not record the review." }, { status: 500 });
  }
}
