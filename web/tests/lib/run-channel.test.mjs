// run-channel.mjs — where /api/run sends each event, and when a run ends.
//
// The bug this guards: one `closed` flag meant both "nobody is reading" and
// "the run is over", so a locked phone (a cancelled response stream) killed an
// evaluation and recorded nothing. These tests pin the split: losing the reader
// keeps the transcript going, keepalives never enter it, and a run finalizes
// exactly once with the outcome the client was also told.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunChannel, runJobId } from "../../src/lib/run-channel.mjs";

function fixture({ enqueueThrows = false } = {}) {
  const streamed = [];
  const logged = [];
  const finished = [];
  let closes = 0;
  let detaches = 0;
  const ch = createRunChannel({
    enqueue: (line) => {
      if (enqueueThrows) throw new TypeError("Invalid state: Controller is already closed");
      streamed.push(JSON.parse(line));
    },
    closeStream: () => { closes++; },
    log: { append: (e) => logged.push(e), finish: (r) => finished.push(r) },
    onDetach: () => { detaches++; },
  });
  return { ch, streamed, logged, finished, closes: () => closes, detaches: () => detaches };
}

test("a detached reader stops the stream, not the transcript", () => {
  const f = fixture();
  f.ch.send({ type: "status", label: "Agent ready" });
  f.ch.detach();
  f.ch.send({ type: "tool", name: "Read", detail: "modes/oferta.md" });
  f.ch.send({ type: "text", text: "VERDICT: 3.4/5 — fine\n" });
  f.ch.send({ type: "done", tokens: 10, costUsd: 0.02 });

  assert.equal(f.ch.attached, false);
  assert.equal(f.ch.finalized, false, "losing the reader must not end the run");
  assert.equal(f.streamed.length, 1);
  assert.equal(f.logged.length, 4, "every event after the disconnect still reaches the job log");
  assert.equal(f.detaches(), 1);
});

test("keepalives go to the response only, never into the job log", () => {
  const f = fixture();
  f.ch.keepalive();
  f.ch.send({ type: "status", label: "x" });
  f.ch.keepalive();
  assert.deepEqual(f.streamed.map((e) => e.type), ["keepalive", "status", "keepalive"]);
  assert.deepEqual(f.logged.map((e) => e.type), ["status"]);
});

test("the client's record count is the log offset: every streamed record was logged first", () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    f.ch.send({ type: "text", text: `${i}` });
    f.ch.keepalive();
  }
  const streamedRecords = f.streamed.filter((e) => e.type !== "keepalive");
  assert.deepEqual(streamedRecords, f.logged);
});

test("an enqueue that throws detaches the reader instead of throwing or ending the run", () => {
  const f = fixture({ enqueueThrows: true });
  assert.doesNotThrow(() => f.ch.send({ type: "status", label: "x" }));
  assert.equal(f.ch.attached, false);
  assert.equal(f.ch.finalized, false);
  f.ch.send({ type: "done" });
  assert.equal(f.logged.length, 2);
});

test("finalize runs exactly once and records the terminal event the client saw", () => {
  const f = fixture();
  f.ch.send({ type: "text", text: "VERDICT: 4.2/5 — strong match\n" });
  f.ch.send({ type: "done", tokens: 1234, costUsd: 0.5, reportN: 42, tldr: { score: 4.2, company: "Acme" } });
  assert.equal(f.ch.finalize({ tokens: 1, costUsd: 0 }), true);
  assert.equal(f.ch.finalize({ tokens: 2 }), false);
  f.ch.finalize();

  assert.equal(f.finished.length, 1);
  assert.deepEqual(f.finished[0], {
    status: "done",
    summary: "VERDICT: 4.2/5 — strong match",
    tokens: 1234,
    costUsd: 0.5,
    reportN: 42,
    tldr: { score: 4.2, company: "Acme" },
  });
  assert.equal(f.closes(), 1);
  // Late events after the run ended are dropped, not logged.
  f.ch.send({ type: "text", text: "late" });
  assert.equal(f.logged.length, 2);
});

test("the first terminal event decides the record, as it decides the client", () => {
  const f = fixture();
  f.ch.send({ type: "error", msg: "Not logged in" });
  f.ch.send({ type: "error", msg: "This run hit an error before finishing" });
  f.ch.finalize({ tokens: 7, costUsd: null });
  assert.deepEqual(f.finished[0], { status: "error", summary: "Not logged in", tokens: 7, costUsd: null });
});

test("a run that ends with no terminal event is recorded as an error, never a silent success", () => {
  const f = fixture();
  f.ch.send({ type: "text", text: "partial" });
  f.ch.finalize();
  assert.equal(f.finished[0].status, "error");
  assert.match(f.finished[0].summary, /without reporting a result/);
});

test("a finalized run with no reader does not touch the closed stream", () => {
  const f = fixture();
  f.ch.detach();
  f.ch.send({ type: "done" });
  f.ch.finalize();
  assert.equal(f.closes(), 0);
  assert.equal(f.finished.length, 1);
});

test("a failing log writer cannot take the run down", () => {
  const ch = createRunChannel({
    enqueue: () => {},
    closeStream: () => {},
    log: { append: () => { throw new Error("EACCES"); }, finish: () => { throw new Error("ENOSPC"); } },
  });
  assert.doesNotThrow(() => ch.send({ type: "done" }));
  assert.doesNotThrow(() => ch.finalize());
  assert.equal(ch.finalized, true);
});

test("runJobId keeps a usable client id and replaces anything that could not be a file name", () => {
  assert.equal(runJobId("job-1760000000000-3"), "job-1760000000000-3");
  for (const bad of [undefined, "", "../etc/passwd", "a/b", "x".repeat(129), 42]) {
    assert.match(runJobId(bad), /^job-\d+-[a-z0-9]+$/);
  }
});
