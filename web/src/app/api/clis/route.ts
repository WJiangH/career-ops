import { NextResponse } from "next/server";
import { detectClis } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";

export const dynamic = "force-dynamic";

// Detects which agnostic CLIs are installed on THIS machine (local-first). The
// web delegates career-ops to one of these in headless mode, on the user's own
// auth/tokens — no API key needed.
//
// `models` per CLI comes from the cache `web/scripts/scan-cli-models.mjs`
// writes. Rescanning happens there, on demand, never on a page load: `grok
// models` takes seconds and codex's list is only readable from a file it
// maintains itself.
export async function GET() {
  return NextResponse.json({ clis: detectClis(careerOpsRoot()) });
}
