"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };

/**
 * The report's own `## Machine Summary` — structured, not prose. Parsed
 * server-side when the run finishes, so it reaches a client that was away for
 * the whole thing. This is what a finished evaluation should show; the text
 * stream only ever carried the agent's inter-tool narration.
 */
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
  startedAt: number;
  endedAt?: number;
  tldr?: JobTldr;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string };

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

const CONFIG_KEY = "career-ops:config";
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

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const seq = useRef(0);
  const loaded = useRef(false);

  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // A "running" job from a previous session is no longer presumed dead.
        // The server owns runs now, so a reload — or a phone that locked and
        // came back — may well be rejoining work that is still going. Keep the
        // optimistic state and let the reconcile effect below settle it against
        // the server, which is the only thing that actually knows.
        setJobs(arr as Job[]);
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);

  // persist
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 40)));
    } catch {
      /* quota */
    }
  }, [jobs]);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  // Reconcile with the server: adopt runs this browser has never seen (started
  // from the Mac, or from this phone before its localStorage was cleared) and
  // settle anything we still think is running. Polls only while something is in
  // flight, so an idle dashboard is silent.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      let serverJobs: Array<{ id: string; kind: string; input: string; title?: string; status: string; startedAt: number; summary?: string; tldr?: JobTldr }>;
      try {
        const r = await fetch("/api/jobs", { cache: "no-store" });
        if (!r.ok) return;
        ({ jobs: serverJobs } = await r.json());
      } catch {
        return; // offline; the run is unaffected, try again next tick
      }
      setJobs((js) => {
        const byId = new Map(js.map((j) => [j.id, j]));
        let changed = false;
        for (const sj of serverJobs) {
          const local = byId.get(sj.id);
          if (!local) {
            // Only adopt live work. Back-filling every historical run would
            // bury the local list under runs the user already dealt with.
            if (sj.status !== "running") continue;
            byId.set(sj.id, {
              id: sj.id, title: sj.title || sj.kind, subtitle: sj.input, page: "/", input: sj.input,
              kind: sj.kind as Job["kind"], status: "running",
              steps: [{ kind: "status", label: "Rejoined — started elsewhere", ts: Date.now() }],
              text: "", startedAt: sj.startedAt,
            } as Job);
            changed = true;
          } else if (local.status === "running" && sj.status !== "running") {
            byId.set(sj.id, { ...local, status: sj.status === "error" ? "error" : "done", endedAt: Date.now(), tldr: sj.tldr ?? local.tldr,
              steps: [...local.steps, { kind: "status", label: sj.summary || "Finished", ts: Date.now() }] });
            changed = true;
          } else if (sj.tldr && !local.tldr) {
            // The client finished the stream itself, so the branch above never
            // fired; the verdict still has to arrive from the server, which is
            // the only side that parses the report.
            byId.set(sj.id, { ...local, tldr: sj.tldr });
            changed = true;
          }
        }
        return changed ? [...byId.values()].sort((a, b) => b.startedAt - a.startedAt) : js;
      });
    };
    void tick();
    const iv = setInterval(() => { if (!stop) void tick(); }, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      let cliId: string | null = null;
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        cliId = raw ? JSON.parse(raw).cliId || null : null;
      } catch {
        cliId = null;
      }
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

      if (!cliId) {
        patch(id, (j) => ({ ...j, status: "error", endedAt: Date.now(), steps: [...j.steps, { kind: "status", label: "No CLI configured — open Config", ts: Date.now() }] }));
        return id;
      }

      (async () => {
        let text = "";
        let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
        let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
        let doneCostUsd: number | null = null;
        const steps: JobStep[] = [];
        const finish = (status: "done" | "error", lastLabel?: string) => {
          const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
          const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
          patch(id, (j) => ({
            ...j,
            status,
            result,
            cost,
            endedAt: Date.now(),
            steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
          }));
          // persist a readable log file so the CLI/assistant can read past runs
          if (status === "done") {
            fetch("/api/runs/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, result, cost, steps, output: text }),
            }).catch(() => {});
            // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
            // worker just wrote a real tracker row / report they don't yet see.
            if (typeof window !== "undefined" && (opts.kind === "evaluate" || opts.kind === "pdf")) {
              window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
            }
          }
        };

        // Events arrive twice over: live from the POST stream while a reader is
        // attached, and from the durable transcript on reconnect. One handler
        // for both, and `seen` counts what we have consumed — the server appends
        // every event to the log before enqueuing it, so that count IS the line
        // offset to resume from.
        let seen = 0;
        let terminal: "done" | "error" | null = null;
        let terminalMsg = "";
        const applyEvent = (ev: { type?: string; name?: string; label?: string; text?: string; tokens?: number; costUsd?: number; msg?: string }) => {
          seen++;
          if (ev.type === "tool") {
            steps.push({ kind: "tool", label: ev.name!, ts: Date.now() });
            patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name!, ts: Date.now() }] }));
          } else if (ev.type === "status") {
            steps.push({ kind: "status", label: ev.label!, ts: Date.now() });
            patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: ev.label!, ts: Date.now() }] }));
          } else if (ev.type === "text") {
            const full = text + ev.text;
            const vm = full.match(/VERDICT:[^\n]*/i);
            if (vm) verdictLine = vm[0];
            text = full.slice(-8000);
            patch(id, (j) => ({ ...j, text }));
          } else if (ev.type === "done") {
            if (typeof ev.tokens === "number") doneTokens = ev.tokens;
            if (typeof ev.costUsd === "number") doneCostUsd = ev.costUsd;
            terminal = "done";
          } else if (ev.type === "error") {
            terminal = "error";
            terminalMsg = ev.msg || "Error";
          }
        };

        // Poll the durable transcript until the server marks the run finished.
        // Deliberately polling, not a second stream: the bug being fixed is that
        // held connections die, so the recovery path must not need one to live.
        const drainFromLog = async () => {
          for (;;) {
            let payload: { events?: unknown[]; nextLine?: number; running?: boolean; job?: { status?: string; summary?: string } };
            try {
              const r = await fetch(`/api/jobs/${id}/events?from=${seen}`, { cache: "no-store" });
              if (!r.ok) { finish("error", "Lost track of this run"); return; }
              payload = await r.json();
            } catch {
              // Still offline — back off and keep trying rather than declaring
              // failure; the run on the Mac is unaffected either way.
              await new Promise((r) => setTimeout(r, 3000));
              continue;
            }
            for (const ev of payload.events ?? []) applyEvent(ev as Parameters<typeof applyEvent>[0]);
            if (terminal) { finish(terminal, terminal === "done" ? "Done" : terminalMsg); return; }
            if (!payload.running) {
              const st = payload.job?.status === "error" ? "error" : "done";
              finish(st, payload.job?.summary || (st === "done" ? "Done" : "Ended"));
              return;
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
        };

        try {
          const res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Hand the server our id so the transcript is addressable the moment
            // the run starts — without it a client that dies early could never
            // find its own job again.
            body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId, jobId: id }),
          });
          if (!res.ok || !res.body) {
            const e = await res.json().catch(() => ({}));
            finish("error", e.error || "Failed to start");
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try { applyEvent(JSON.parse(line)); } catch { /* partial */ }
            }
            if (terminal === "error") { finish("error", terminalMsg); return; }
          }
          if (terminal) { finish(terminal, terminal === "done" ? "Done" : terminalMsg); return; }
          // Stream ended with no verdict — the reader was cut off, not the run.
          // The work is still going on the Mac; pick it back up from the log.
          await drainFromLog();
        } catch {
          // Network dropped mid-stream (screen lock, app switch, Wi-Fi change).
          // Same story: reattach instead of reporting a failure that did not happen.
          await drainFromLog();
        }
      })();

      return id;
    },
    [patch],
  );

  const removeJob = useCallback((id: string) => setJobs((js) => js.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.status === "running")), []);

  return <JobsContext.Provider value={{ jobs, startJob, removeJob, clearFinished }}>{children}</JobsContext.Provider>;
}
