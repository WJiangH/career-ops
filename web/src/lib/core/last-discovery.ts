// The most recent completed discovery sweep, kept on disk.
//
// A scan is a query producing a result set, not a stream of side effects — so
// unlike an evaluation it needs no transcript, just its answer. Backgrounding
// the PWA cancels the fetch holding the stream, and the sweep's output went
// with it: the server had finished the work and the phone showed "Couldn't
// finish the search. Load failed". Keeping the last result lets a returning
// client collect what already ran instead of paying for it twice.
//
// Exactly one slot. Discovery is idempotent and cheap to redo, so history has
// no value here; a single file also means no cleanup policy to get wrong.

import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export interface LastDiscovery {
  /** Correlates with the client's request, so a stale sweep is not mistaken for this one. */
  runId: string | null;
  finishedAt: number;
  event: unknown;
}

function file(): string {
  const dir = path.join(careerOpsRoot(), ".career-ops-web");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "last-discovery.json");
}

/** Never throws — failing to cache a result must not fail the scan that produced it. */
export function saveLastDiscovery(d: LastDiscovery): void {
  try {
    // Write-then-rename: a client polling mid-write would otherwise read a
    // truncated file and treat a good sweep as corrupt.
    const f = file();
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, f);
  } catch {
    /* best-effort */
  }
}

export function readLastDiscovery(): LastDiscovery | null {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as LastDiscovery;
  } catch {
    return null;
  }
}
