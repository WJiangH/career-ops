"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import { CONFIG_KEY, resolveCliId } from "@/lib/saved-cli";

// Model/effort are keyed by CLI in Config: "xhigh" is valid on claude and codex
// but not grok, and a model name means nothing to another vendor.
function cliTuning(cliId: string): { model?: string; effort?: string } {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : null;
    return { model: cfg?.models?.[cliId] || undefined, effort: cfg?.efforts?.[cliId] || undefined };
  } catch {
    return {}; // unreadable config: run with the CLI's defaults
  }
}
import { createWorkerFeedback } from "@/lib/worker-feedback.mjs";
import { readJobStream } from "@/lib/job-stream.mjs";
import { followJobLog, interpretRecord, type FollowCompletion, type FollowProgress } from "@/lib/job-follow.mjs";
import { createJobsPersister } from "@/lib/jobs-persist.mjs";

// `detail` is the tool's argument (file read, command run, query searched).
export type JobStep = { kind: "tool" | "status"; label: string; detail?: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };

// The report's Machine Summary, shown by the fork's /jobs/[id] page. The server
// parses it when it persists an evaluation and sends it on the `done` record,
// so a client that was away for the whole run still gets the verdict.
export type JobTldr = {
  company?: string; role?: string; score?: number; archetype?: string;
  final_decision?: string; legitimacy_tier?: string; work_auth?: string;
  risk_level?: string; confidence?: string; next_action?: string;
  hard_stops?: string[]; soft_gaps?: string[]; top_strengths?: string[];
  report?: string;
};

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: "running" | "done" | "error";
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  reportN?: number | null;
  tldr?: JobTldr;
  startedAt: number;
  endedAt?: number;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string; brief?: Record<string, string> };

type Ctx = {
  jobs: Job[];
  startJob: (opts: StartOpts) => string | null;
  removeJob: (id: string) => void;
  clearFinished: () => void;
};

const JobsContext = createContext<Ctx | null>(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

const JOBS_KEY = "career-ops:jobs";

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

// Client state for one run this tab is following. The live stream and the
// job-log poll share it, so they share one offset and one accumulated text.
type Follow = {
  seen: number; // transcript records consumed = the job-log line to resume from
  steps: JobStep[];
  text: string;
  verdictLine: string; // latched separately so the 8000-char tail can't drop it
  abort: AbortController | null; // the live POST stream, while it is attached
  stopped: boolean; // removed from the list: stop following
};
const newFollow = (): Follow => ({ seen: 0, steps: [], text: "", verdictLine: "", abort: null, stopped: false });

// The persisted Machine Summary score is what the tracker row holds, so it
// wins over a score scraped from the agent's narration.
function resultFor(f: Follow, tldr?: JobTldr): JobResult {
  const parsed = parseVerdict(f.verdictLine || f.text);
  if (typeof tldr?.score !== "number") return parsed;
  return { score: tldr.score, summary: parsed.summary || tldr.final_decision || "", tone: scoreTone(`${tldr.score}`) };
}

type ServerJob = { id: string; kind: string; input: string; title?: string; status: string; startedAt: number };

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const feedback = useRef<ReturnType<typeof createWorkerFeedback> | null>(null);
  useEffect(() => {
    const owner = createWorkerFeedback(setAnnouncement);
    feedback.current = owner;
    return () => { owner.dispose(); feedback.current = null; };
  }, []);
  const seq = useRef(0);
  const loaded = useRef(false);
  const restored = useRef<Job[]>([]);
  const follows = useRef(new Map<string, Follow>());
  const jobsRef = useRef<Job[]>([]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // A job left "running" is not presumed dead: the server owns runs, so a
        // reload may be rejoining work that is still going. The job log settles
        // it, and a run the server never heard of comes back as interrupted.
        restored.current = (arr as Job[]).filter((j) => j.status === "running");
        setJobs(arr as Job[]);
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);

  // persist. Every streamed chunk replaces `jobs`, so writes go through the
  // persister: at once when nothing runs, at most once a second while a job
  // streams, and flushed when the page is hidden or the provider unmounts.
  const persister = useRef<ReturnType<typeof createJobsPersister<Job>> | null>(null);
  if (persister.current === null) {
    persister.current = createJobsPersister<Job>({
      write: (list) => {
        try {
          localStorage.setItem(JOBS_KEY, JSON.stringify(list.slice(0, 40)));
        } catch {
          /* quota */
        }
      },
      isActive: (list) => list.some((j) => j.status === "running"),
    });
  }
  useEffect(() => {
    const owner = persister.current;
    const flush = () => owner?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    persister.current?.save(jobs);
  }, [jobs]);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  const applyProgress = useCallback(
    (id: string, f: Follow, ev: FollowProgress) => {
      if (ev.type === "tool" || ev.type === "status") {
        const step: JobStep =
          ev.type === "tool"
            ? { kind: "tool", label: ev.name, ...(ev.detail ? { detail: ev.detail } : {}), ts: Date.now() }
            : { kind: "status", label: ev.label, ts: Date.now() };
        f.steps.push(step);
        patch(id, (j) => ({ ...j, steps: [...j.steps, step] }));
      } else if (ev.type === "text") {
        const full = f.text + ev.text;
        const vm = full.match(/VERDICT:[^\n]*/i);
        if (vm) f.verdictLine = vm[0];
        f.text = full.slice(-8000);
        const text = f.text;
        patch(id, (j) => ({ ...j, text }));
      }
    },
    [patch],
  );

  // The one place a run ends on this client, whether the stream or the job log
  // carried its last record.
  const settle = useCallback(
    (job: Job, f: Follow, completion: FollowCompletion) => {
      follows.current.delete(job.id);
      if (f.stopped) return;
      const { status } = completion;
      feedback.current?.push({ ...job, status });
      const tldr = completion.status === "done" ? (completion.tldr as JobTldr | undefined) : undefined;
      const result = completion.status === "done" ? resultFor(f, tldr) : undefined;
      const cost = completion.status === "done" && (completion.tokens ?? 0) > 0 ? { tokens: completion.tokens ?? 0, usd: completion.costUsd ?? undefined } : undefined;
      const reportN = completion.status === "done" && typeof completion.reportN === "number" ? completion.reportN : null;
      const lastLabel = completion.status === "done" ? "Done" : completion.message;
      patch(job.id, (j) => ({
        ...j,
        status,
        result,
        cost,
        reportN,
        tldr: tldr ?? j.tldr,
        endedAt: Date.now(),
        steps: [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }],
      }));
      // persist a readable log file so the CLI/assistant can read past runs
      if (status === "done") {
        fetch("/api/runs/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: job.id, title: job.title, subtitle: job.subtitle, page: job.page, input: job.input, result, cost, steps: f.steps, output: f.text }),
        }).catch(() => {});
        // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
        // worker just wrote a real tracker row / report they don't yet see.
        if (typeof window !== "undefined" && (job.kind === "evaluate" || job.kind === "pdf")) {
          window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: job.kind, input: job.input } }));
        }
      }
    },
    [patch],
  );

  // Follow a run from the job log, starting after the records this tab has
  // already consumed. The run on the server never noticed the reader left.
  const followFromLog = useCallback(
    async (job: Job, f: Follow) => {
      const completion = await followJobLog({
        id: job.id,
        from: f.seen,
        onProgress: (ev) => applyProgress(job.id, f, ev),
        onRecord: () => { f.seen++; },
        shouldStop: () => f.stopped,
      });
      if (completion) settle(job, f, completion);
      else follows.current.delete(job.id);
    },
    [applyProgress, settle],
  );

  // Rejoin a run this tab is not following yet (restored after a reload, or
  // started from another device). The log is replayed from the start, so the
  // trace is rebuilt from the server's record rather than appended to.
  const rejoin = useCallback(
    (job: Job, label: string) => {
      if (follows.current.has(job.id)) return;
      const f = newFollow();
      follows.current.set(job.id, f);
      patch(job.id, (j) => ({ ...j, text: "", steps: [{ kind: "status", label, ts: Date.now() }] }));
      void followFromLog(job, f);
    },
    [patch, followFromLog],
  );

  // Restored "running" jobs rejoin once the provider has loaded them.
  useEffect(() => {
    const pending = restored.current;
    restored.current = [];
    for (const j of pending) rejoin(j, "Rejoined after reload");
  }, [rejoin]);

  // Reconcile with the server: rejoin runs this tab has never seen (started on
  // the Mac, or before this phone's storage was cleared), and when the page
  // comes back into view, drop any held stream for the job log. A locked phone
  // or backgrounded PWA can leave a fetch stream dead without an error, and
  // only the log is guaranteed to carry on from where it stopped.
  useEffect(() => {
    let disposed = false;
    const reconcile = async (reattach: boolean) => {
      if (reattach) for (const f of follows.current.values()) f.abort?.abort();
      let serverJobs: ServerJob[];
      try {
        const r = await fetch("/api/jobs", { cache: "no-store" });
        if (!r.ok) return;
        serverJobs = ((await r.json()) as { jobs?: ServerJob[] }).jobs ?? [];
      } catch {
        return; // offline: the runs are unaffected, try again on the next return
      }
      if (disposed) return;
      const known = new Set(jobsRef.current.map((j) => j.id));
      // Only live work. Back-filling every finished run would bury the local
      // list under runs the user already dealt with.
      const adopt: Job[] = serverJobs
        .filter((sj) => sj.status === "running" && !known.has(sj.id) && !follows.current.has(sj.id))
        .map((sj) => ({
          id: sj.id,
          title: sj.title || sj.kind,
          subtitle: sj.input,
          input: sj.input,
          kind: sj.kind,
          status: "running",
          steps: [],
          text: "",
          startedAt: sj.startedAt,
        }));
      if (adopt.length === 0) return;
      setJobs((js) => [...adopt.filter((a) => !js.some((j) => j.id === a.id)), ...js].sort((a, b) => b.startedAt - a.startedAt));
      for (const j of adopt) rejoin(j, "Rejoined — started elsewhere");
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void reconcile(true);
    };
    void reconcile(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rejoin]);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      const id = `job-${Date.now()}-${seq.current++}`;
      const job: Job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        batchId: opts.batchId,
        status: "running",
        steps: [{ kind: "status", label: "Starting…", ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      setJobs((js) => [job, ...js]);
      const f = newFollow();
      follows.current.set(id, f);

      (async () => {
        // resolveCliId() validates the saved id against what is installed; a
        // bare readSavedCliId() here would short-circuit that check and launch
        // a run against an uninstalled CLI (#4012).
        // A stale saved id is replaced silently otherwise — name the switch in
        // the job log so a transient "not installed" can't rewrite the user's
        // choice without a record. It goes in f.steps, which is the log sent to
        // /api/runs/save, not only in the live job.
        const cliId = await resolveCliId((stale, replacement) => {
          const label = replacement
            ? `Saved CLI '${stale}' is not installed — using '${replacement}'`
            : `Saved CLI '${stale}' is not installed`;
          const step: JobStep = { kind: "status", label, ts: Date.now() };
          f.steps.push(step);
          patch(id, (j) => ({ ...j, steps: [...j.steps, step] }));
        });
        if (!cliId) {
          follows.current.delete(id);
          feedback.current?.push({ ...job, status: "error" });
          patch(id, (j) => ({
            ...j,
            status: "error",
            endedAt: Date.now(),
            steps: [...j.steps, { kind: "status", label: "No CLI configured — open Config and click Save config", ts: Date.now() }],
          }));
          return;
        }

        const last: { terminal: Record<string, unknown> | null } = { terminal: null };
        try {
          const abort = new AbortController();
          f.abort = abort;
          const res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Our id goes to the server so the run's transcript is addressable
            // the moment it starts: a client that loses the stream finds it again.
            body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId, brief: opts.brief, jobId: id, title: opts.title, ...cliTuning(cliId) }),
            signal: abort.signal,
          });
          if (!res.ok || !res.body) {
            f.abort = null;
            const e = await res.json().catch(() => ({}));
            settle(job, f, { status: "error", message: e.error || "Failed to start" });
            return;
          }
          await readJobStream(
            res.body,
            (ev) => applyProgress(id, f, ev),
            (record) => {
              f.seen++;
              if (last.terminal === null && (record.type === "done" || record.type === "error")) last.terminal = record;
            },
          );
        } catch {
          // fetch itself failed or was aborted: same as a stream cut off below.
        }
        f.abort = null;
        const ended = last.terminal ? interpretRecord(last.terminal) : null;
        if (ended && "completion" in ended) {
          settle(job, f, ended.completion);
          return;
        }
        if (f.stopped) {
          follows.current.delete(id);
          return;
        }
        // The stream ended without the server's verdict: the reader was cut off
        // (screen lock, app switch, Wi-Fi change), not the run. It is still
        // going on the server, so pick it back up from the job log.
        patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: "Connection lost — following the run on the server", ts: Date.now() }] }));
        await followFromLog(job, f);
      })();

      return id;
    },
    [patch, applyProgress, settle, followFromLog],
  );

  const removeJob = useCallback((id: string) => {
    const f = follows.current.get(id);
    if (f) {
      // Stops this tab following the run; the run itself carries on.
      f.stopped = true;
      f.abort?.abort();
      follows.current.delete(id);
    }
    setJobs((js) => js.filter((j) => j.id !== id));
  }, []);
  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.status === "running")), []);

  // A new object only when the list or an action changes, not on every render
  // of this provider (the screen-reader announcement re-renders it too).
  const value = useMemo(() => ({ jobs, startJob, removeJob, clearFinished }), [jobs, startJob, removeJob, clearFinished]);

  return (
    <JobsContext.Provider value={value}>
      {children}
      <div role="status" aria-label="Worker task status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
    </JobsContext.Provider>
  );
}
