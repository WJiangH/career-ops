/**
 * job-follow.mjs — pick a run back up from its server-side transcript.
 *
 * /api/run keeps running when the client that started it goes away (see
 * run-channel.mjs), and appends every event to the job log first. A client
 * whose stream ended without a terminal event (a locked phone, a backgrounded
 * PWA, a reload) follows the run here instead of reporting a failure that did
 * not happen.
 *
 * Polling, not a second held stream: the failure being fixed IS held
 * connections dying, so the recovery path must not need one to stay alive.
 */

/**
 * @typedef {{ type: "text", text: string } | { type: "tool", name: string, detail?: string } | { type: "status", label: string }} FollowProgress
 * @typedef {{ status: "done", tokens?: number, costUsd?: number, reportN?: number, tldr?: Record<string, unknown> } | { status: "error", message: string }} FollowCompletion
 */

/**
 * Classify one transcript record the way readJobStream classifies a streamed
 * line, so a run reads the same live and replayed.
 * @param {unknown} record
 * @returns {{ progress: FollowProgress } | { completion: FollowCompletion } | null}
 */
export function interpretRecord(record) {
  if (!record || typeof record !== "object") return null;
  const ev = /** @type {Record<string, unknown>} */ (record);
  if (ev.type === "error") {
    return { completion: { status: "error", message: typeof ev.msg === "string" && ev.msg ? ev.msg : "Error" } };
  }
  if (ev.type === "done") return { completion: doneCompletion(ev) };
  if (ev.type === "text" && typeof ev.text === "string") return { progress: { type: "text", text: ev.text } };
  if (ev.type === "tool" && typeof ev.name === "string") {
    return { progress: typeof ev.detail === "string" && ev.detail ? { type: "tool", name: ev.name, detail: ev.detail } : { type: "tool", name: ev.name } };
  }
  if (ev.type === "status" && typeof ev.label === "string") return { progress: { type: "status", label: ev.label } };
  return null;
}

/** @param {Record<string, unknown>} ev @returns {FollowCompletion} */
function doneCompletion(ev) {
  return {
    status: "done",
    ...(typeof ev.tokens === "number" ? { tokens: ev.tokens } : {}),
    ...(typeof ev.costUsd === "number" ? { costUsd: ev.costUsd } : {}),
    ...(typeof ev.reportN === "number" ? { reportN: ev.reportN } : {}),
    ...(ev.tldr && typeof ev.tldr === "object" ? { tldr: /** @type {Record<string, unknown>} */ (ev.tldr) } : {}),
  };
}

/**
 * Follow a run's transcript from line `from` until it ends.
 *
 * `onRecord` is called once per transcript record consumed, so the caller's
 * offset stays exact across a later resume. A run the server finished without
 * a terminal record in the log (an unwritable log, a restart) settles from the
 * job record itself. Offline is not failure: it retries until the server
 * answers, because the run on the server is unaffected either way.
 *
 * @param {{
 *   id: string,
 *   from?: number,
 *   fetchFn?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number,
 *   offlineMs?: number,
 *   onProgress: (event: FollowProgress) => void,
 *   onRecord?: (record: unknown) => void,
 *   shouldStop?: () => boolean,
 * }} opts
 * @returns {Promise<FollowCompletion | null>} null when shouldStop() ended it.
 */
export async function followJobLog({
  id,
  from = 0,
  fetchFn = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 1500,
  offlineMs = 3000,
  onProgress,
  onRecord,
  shouldStop = () => false,
}) {
  let offset = from;
  for (;;) {
    if (shouldStop()) return null;
    let payload;
    try {
      const res = await fetchFn(`/api/jobs/${encodeURIComponent(id)}/events?from=${offset}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 400) {
        return { status: "error", message: "Interrupted — the server has no record of this run. Check the pipeline before retrying." };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch {
      await sleep(offlineMs);
      continue;
    }
    if (shouldStop()) return null;
    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const record of events) {
      offset++;
      onRecord?.(record);
      const r = interpretRecord(record);
      if (!r) continue;
      if ("completion" in r) return r.completion;
      onProgress(r.progress);
    }
    // A run that ended between the append and this read has its terminal record
    // in `events`; settling from `job` only covers a log missing that record.
    if (payload?.running === false) {
      const job = payload.job ?? {};
      if (job.status === "done") return doneCompletion({ ...job, type: "done" });
      return { status: "error", message: typeof job.summary === "string" && job.summary ? job.summary : "The run ended without reporting a result." };
    }
    await sleep(pollMs);
  }
}
