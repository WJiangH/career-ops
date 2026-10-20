// job-follow.mjs — the client picking a run back up from the job log after its
// stream ended without the server's verdict (locked phone, backgrounded PWA,
// reload). The run kept going on the server; these tests pin that the client
// resumes from the exact record it stopped at and settles the way the live
// stream would have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { followJobLog, interpretRecord } from "../../src/lib/job-follow.mjs";

/** A fake events route over a growing transcript. `script` mutates it per poll. */
function server(transcript, { script = () => {}, status = 200, job = { status: "running" } } = {}) {
  const requests = [];
  let poll = 0;
  const fetchFn = async (url) => {
    requests.push(url);
    script(poll++, transcript, job);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const from = Number(new URL(url, "http://x").searchParams.get("from"));
    const events = transcript.slice(from);
    return {
      ok: true,
      status: 200,
      json: async () => ({ job, events, nextLine: from + events.length, running: job.status === "running" }),
    };
  };
  return { fetchFn, requests };
}

const sleep = async () => {};

test("resumes from the offset and settles on the terminal record, with the verdict", async () => {
  const transcript = [
    { type: "status", label: "Agent ready" },
    { type: "tool", name: "Read", detail: "modes/oferta.md" },
    { type: "text", text: "Reading the posting\n" },
    { type: "tool", name: "WebFetch", detail: "jobs.example.com/1" },
  ];
  const { fetchFn, requests } = server(transcript, {
    script: (poll, t) => {
      if (poll === 1) t.push({ type: "done", tokens: 99, costUsd: 0.3, reportN: 7, tldr: { score: 3.9 } });
    },
  });
  const progress = [];
  let records = 0;
  const completion = await followJobLog({ id: "job-1", from: 2, fetchFn, sleep, onProgress: (e) => progress.push(e), onRecord: () => records++ });

  assert.deepEqual(completion, { status: "done", tokens: 99, costUsd: 0.3, reportN: 7, tldr: { score: 3.9 } });
  assert.deepEqual(progress, [
    { type: "text", text: "Reading the posting\n" },
    { type: "tool", name: "WebFetch", detail: "jobs.example.com/1" },
  ], "records the client already had are not replayed twice");
  assert.equal(records, 3);
  assert.deepEqual(requests, ["/api/jobs/job-1/events?from=2", "/api/jobs/job-1/events?from=4"]);
});

test("an error record settles as the error the stream would have shown", async () => {
  const { fetchFn } = server([{ type: "error", msg: "This run passed the 740s time limit" }]);
  const completion = await followJobLog({ id: "j", fetchFn, sleep, onProgress: () => {} });
  assert.deepEqual(completion, { status: "error", message: "This run passed the 740s time limit" });
});

test("offline is not failure: it keeps retrying until the server answers", async () => {
  const transcript = [{ type: "done" }];
  let calls = 0;
  const { fetchFn: answer } = server(transcript);
  const fetchFn = async (url) => {
    if (calls++ < 3) throw new TypeError("Load failed");
    return answer(url);
  };
  const completion = await followJobLog({ id: "j", fetchFn, sleep, onProgress: () => {} });
  assert.deepEqual(completion, { status: "done" });
  assert.equal(calls, 4);
});

test("a run the server has no record of comes back interrupted", async () => {
  const { fetchFn } = server([], { status: 404 });
  const completion = await followJobLog({ id: "j", fetchFn, sleep, onProgress: () => {} });
  assert.equal(completion.status, "error");
  assert.match(completion.message, /no record of this run/);
});

test("a finished job with no terminal record settles from the job record", async () => {
  const done = server([{ type: "text", text: "x" }], { job: { status: "done", tokens: 5, tldr: { score: 2 } } });
  assert.deepEqual(await followJobLog({ id: "j", fetchFn: done.fetchFn, sleep, onProgress: () => {} }), { status: "done", tokens: 5, tldr: { score: 2 } });

  const orphaned = server([], { job: { status: "error", summary: "Interrupted — the server restarted while this was running." } });
  assert.deepEqual(await followJobLog({ id: "j", fetchFn: orphaned.fetchFn, sleep, onProgress: () => {} }), {
    status: "error",
    message: "Interrupted — the server restarted while this was running.",
  });
});

test("shouldStop ends the follow without settling", async () => {
  const { fetchFn } = server([{ type: "status", label: "x" }]);
  let stop = false;
  const completion = await followJobLog({ id: "j", fetchFn, sleep: async () => { stop = true; }, onProgress: () => {}, shouldStop: () => stop });
  assert.equal(completion, null);
});

test("interpretRecord ignores keepalives and unknown records, keeps tool detail", () => {
  assert.equal(interpretRecord({ type: "keepalive" }), null);
  assert.equal(interpretRecord({ type: "future-thing" }), null);
  assert.equal(interpretRecord(null), null);
  assert.deepEqual(interpretRecord({ type: "tool", name: "Bash", detail: "node verify-pipeline.mjs" }), {
    progress: { type: "tool", name: "Bash", detail: "node verify-pipeline.mjs" },
  });
  assert.deepEqual(interpretRecord({ type: "tool", name: "Bash" }), { progress: { type: "tool", name: "Bash" } });
  assert.deepEqual(interpretRecord({ type: "error" }), { completion: { status: "error", message: "Error" } });
});
