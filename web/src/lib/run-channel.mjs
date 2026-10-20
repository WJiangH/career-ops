/**
 * run-channel.mjs — the one place /api/run decides where an event goes.
 *
 * A run used to end when its reader did: a locked phone or a backgrounded PWA
 * cancelled the response stream, cancel() killed the agent child, and eight
 * minutes of evaluation vanished with nothing written. One `closed` flag meant
 * both "nobody is reading" and "the run is over", so it could not tell them
 * apart.
 *
 * This keeps the two states separate:
 *
 *   attached  — someone is reading the HTTP stream. Cleared by detach() (the
 *               stream's cancel(), or an enqueue that throws). Losing the reader
 *               only stops enqueuing; the child, the transcript and the honesty
 *               gates keep running.
 *   finalized — the run itself is over. Set once by finalize(), which writes
 *               the job record and closes the stream. Late events are dropped.
 *
 * Every transcript event is appended to the job log BEFORE it is enqueued, so
 * the number of events a client has read is exactly the line offset it resumes
 * from (GET /api/jobs/{id}/events?from=N). Keepalives are transport, not
 * transcript: they go straight to the response and never into the log, where
 * one every 10s would bury what a reconnecting client replays.
 *
 * Plain JS with injected I/O so the route's lifecycle has a reachable test; the
 * route itself is a TypeScript closure node --test cannot drive on its own.
 */

/**
 * @typedef {{ status: "done" | "error", summary?: string, tokens?: number, costUsd?: number | null, reportN?: number, tldr?: Record<string, unknown> }} RunRecord
 */

const VERDICT_RE = /VERDICT:[^\n]*/i;

/**
 * @param {{
 *   enqueue: (line: string) => void,
 *   closeStream: () => void,
 *   log: { append: (event: unknown) => void, finish: (record: RunRecord) => void },
 *   onDetach?: () => void,
 * }} io
 */
export function createRunChannel({ enqueue, closeStream, log, onDetach }) {
  let attached = true;
  let finalized = false;
  /** @type {Record<string, any> | null} First terminal event wins, the same rule readJobStream applies on the client. */
  let terminal = null;
  // Rolling tail of agent text, only to find a VERDICT line for the job list.
  let textTail = "";
  let verdict = "";

  const best = (fn) => {
    try { fn(); } catch { /* the run matters more than its transcript */ }
  };

  const detach = () => {
    if (!attached) return;
    attached = false;
    if (onDetach) best(onDetach);
  };

  const write = (line) => {
    if (!attached || finalized) return;
    try {
      enqueue(line);
    } catch {
      // The reader is gone without cancel() having said so. Same as a cancel:
      // stop writing to it, keep running.
      detach();
    }
  };

  return {
    get attached() { return attached; },
    get finalized() { return finalized; },

    /** A transcript event: logged first, unconditionally, then streamed if anyone reads. */
    send(event) {
      if (finalized) return;
      const type = event && typeof event === "object" ? event.type : undefined;
      if ((type === "done" || type === "error") && terminal === null) terminal = event;
      if (type === "text" && typeof event.text === "string") {
        textTail = (textTail + event.text).slice(-4000);
        const m = textTail.match(VERDICT_RE);
        if (m) verdict = m[0].trim();
      }
      best(() => log.append(event));
      write(JSON.stringify(event) + "\n");
    },

    /** Transport only: keeps an idle connection open, never recorded. */
    keepalive() {
      write(JSON.stringify({ type: "keepalive" }) + "\n");
    },

    /** The reader went away. The run carries on. */
    detach,

    /**
     * End the run exactly once. Status comes from the terminal event the client
     * also saw, so the record and the live UI cannot disagree; a run that ends
     * with neither is recorded as an error rather than a silent success.
     * @param {{ tokens?: number, costUsd?: number | null }} [usage]
     * @returns {boolean} true on the call that finalized.
     */
    finalize(usage = {}) {
      if (finalized) return false;
      finalized = true;
      /** @type {RunRecord} */
      const record = terminal?.type === "done"
        ? { status: "done", ...(verdict ? { summary: verdict.slice(0, 200) } : {}) }
        : { status: "error", summary: typeof terminal?.msg === "string" && terminal.msg ? terminal.msg : "The run ended without reporting a result." };
      const tokens = typeof terminal?.tokens === "number" ? terminal.tokens : usage.tokens;
      if (typeof tokens === "number") record.tokens = tokens;
      const costUsd = typeof terminal?.costUsd === "number" ? terminal.costUsd : usage.costUsd;
      if (costUsd !== undefined) record.costUsd = costUsd;
      if (typeof terminal?.reportN === "number") record.reportN = terminal.reportN;
      if (terminal?.tldr && typeof terminal.tldr === "object") record.tldr = terminal.tldr;
      best(() => log.finish(record));
      if (attached) best(closeStream);
      return true;
    },
  };
}

// Ids reach the filesystem as job-log file names. A malformed one is replaced,
// not sanitized: a rewritten id would read back as a different job, and the
// client could never find its run again.
const JOB_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The id this run's transcript lives under: the client's own when it sent a
 * usable one (so it can resubscribe without being told), otherwise a fresh one.
 * @param {unknown} requested
 * @returns {string}
 */
export function runJobId(requested) {
  if (typeof requested === "string" && JOB_ID_RE.test(requested)) return requested;
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
