// Server-side job log — the durable record of a CLI run.
//
// Why this exists: a run used to be owned by the browser. The client minted the
// id, held the HTTP stream, accumulated the text in React state, and only then
// asked the server to save a summary. Close the tab — or lock a phone, which
// suspends the web view — and the stream cancelled, the child was killed, and
// nothing was written. An 8-minute evaluation vanished for switching apps.
//
// So the server owns the run now. Events are appended here as they arrive,
// independent of whether anyone is listening, and a reconnecting client replays
// from a line offset. One file pair per job, no shared index: two jobs finishing
// at the same instant can never contend, which a single jobs.json would invite.
//
// Lives under .career-ops-web/ — already gitignored as "runtime cache/history
// the dashboard writes locally".

import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export type JobStatus = "running" | "done" | "error";

export interface JobMeta {
  id: string;
  kind: string;
  input: string;
  title?: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  tokens?: number;
  costUsd?: number | null;
  /** Final one-line outcome — the verdict for an evaluation, or the error. */
  summary?: string;
  /**
   * The report's own Machine Summary, parsed server-side the moment the run
   * finishes. Stored here rather than fetched on demand so a client that was
   * away for the whole run still gets the verdict from a plain /api/jobs read.
   */
  tldr?: Record<string, unknown>;
}

function jobsDir(): string {
  const dir = path.join(careerOpsRoot(), ".career-ops-web", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Ids reach the filesystem, so anything but [A-Za-z0-9._-] is rejected rather
// than sanitized: a silently-rewritten id would read back as a different job.
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function paths(id: string): { meta: string; events: string } {
  if (!ID_RE.test(id)) throw new Error(`invalid job id: ${id}`);
  const dir = jobsDir();
  return { meta: path.join(dir, `${id}.json`), events: path.join(dir, `${id}.ndjson`) };
}

export function createJob(meta: Omit<JobMeta, "status" | "startedAt">): JobMeta {
  const full: JobMeta = { ...meta, status: "running", startedAt: Date.now() };
  const p = paths(full.id);
  fs.writeFileSync(p.meta, JSON.stringify(full, null, 2));
  fs.writeFileSync(p.events, "");
  return full;
}

/** Append one event. Never throws — a failed log write must not kill the run. */
export function appendEvent(id: string, event: unknown): void {
  try {
    fs.appendFileSync(paths(id).events, JSON.stringify(event) + "\n");
  } catch {
    /* best-effort: the run matters more than its transcript */
  }
}

export function finishJob(id: string, patch: Partial<JobMeta> & { status: JobStatus }): void {
  try {
    const p = paths(id);
    const prev = readJob(id);
    const next: JobMeta = { ...(prev ?? ({ id, kind: "", input: "", startedAt: Date.now() } as JobMeta)), ...patch, endedAt: Date.now() };
    fs.writeFileSync(p.meta, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
}

export function readJob(id: string): JobMeta | null {
  try {
    return JSON.parse(fs.readFileSync(paths(id).meta, "utf8")) as JobMeta;
  } catch {
    return null;
  }
}

/**
 * Events from `fromLine` onward, plus the next offset to resume at. A client
 * that dropped mid-run reconnects with the count it already has and receives
 * only what it missed.
 */
export function readEvents(id: string, fromLine = 0): { events: unknown[]; nextLine: number } {
  let raw = "";
  try {
    raw = fs.readFileSync(paths(id).events, "utf8");
  } catch {
    return { events: [], nextLine: fromLine };
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const slice = lines.slice(fromLine);
  const events: unknown[] = [];
  for (const l of slice) {
    try {
      events.push(JSON.parse(l));
    } catch {
      /* torn final line — a concurrent append; it arrives whole next poll */
    }
  }
  return { events, nextLine: fromLine + events.length };
}

/** Newest first. `limit` caps the scan so a long history stays cheap to list. */
export function listJobs(limit = 50): JobMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(jobsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs: JobMeta[] = [];
  for (const n of names) {
    const j = readJob(n.slice(0, -".json".length));
    if (j) jobs.push(j);
  }
  jobs.sort((a, b) => b.startedAt - a.startedAt);
  return jobs.slice(0, limit);
}

/**
 * Mark still-"running" jobs from a previous server process as errored.
 * The child was a child of THAT process: a restart orphans it, and without this
 * the job list shows a spinner that can never resolve. Called once at startup.
 */
export function reapStaleJobs(): number {
  let n = 0;
  for (const j of listJobs(200)) {
    if (j.status !== "running") continue;
    finishJob(j.id, { status: "error", summary: "Interrupted — the server restarted while this was running." });
    n++;
  }
  return n;
}
