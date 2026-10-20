// /api/run keeps a run going when the client that started it goes away.
//
// Driven for real: the route handler is imported under the @/ loader, a
// stand-in `claude` on PATH plays a structured stream with a pause in the
// middle, and the test reads the response until the run is underway, then
// cancels it — what a locked phone or a backgrounded PWA does to the fetch.
// Before this, cancel() SIGTERM'd the child and nothing was recorded.
//
// Then the reconnect path: GET /api/jobs/{id}/events?from=N, from the number of
// records the client had read, returns exactly what it missed, and the job
// record carries the outcome, written once.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import "../helpers/web-ts-alias-loader.mjs";

const dataRoot = mkdtempSync(join(tmpdir(), "co-run-outlives-data-"));
const binDir = mkdtempSync(join(tmpdir(), "co-run-outlives-bin-"));
const marker = join(dataRoot, "fake-claude-finished");
const ENV_KEYS = ["CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_TRACKER", "PATH", "FAKE_CLAUDE_MARKER"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Speaks Claude Code's stream-json: ready, some text and a tool, a pause long
// enough for the client to leave, the verdict, a usage result, then a marker
// file proving it ran to the end rather than being killed.
const FAKE_CLAUDE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init" });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Researching the company\\n" } } });
out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "WebSearch" } } });
setTimeout(() => {
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "VERDICT: 3.8/5 — worth a look\\n" } } });
  out({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.01 });
  require("node:fs").writeFileSync(process.env.FAKE_CLAUDE_MARKER, "done");
  process.exit(0);
}, 1500);
`;

before(() => {
  process.env.CAREER_OPS_ROOT = dataRoot;
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_TRACKER = "";
  process.env.FAKE_CLAUDE_MARKER = marker;
  const bin = join(binDir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
  mkdirSync(join(dataRoot, "config"), { recursive: true });
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a client disconnect does not kill the run, and the reconnect path replays what it missed", async () => {
  const { POST } = await import("@/app/api/run/route.ts");
  const eventsRoute = await import("@/app/api/jobs/[id]/events/route.ts");
  const { readJob } = await import("@/lib/core/job-log.ts");

  const jobId = `job-${Date.now()}-0`;
  const res = await POST(new Request("http://localhost/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "research", input: "Acme Robotics", cliId: "claude", jobId, title: "Research Acme" }),
  }));
  // Not res.clone().text() for the message: that would read the stream to its end.
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Job-Id"), jobId);

  // Read like the client does until the agent is visibly at work, then leave.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen = [];
  while (!seen.some((e) => e.type === "tool")) {
    const { value, done } = await reader.read();
    assert.equal(done, false, "the stream ended before the run was underway");
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) seen.push(JSON.parse(line));
    }
  }
  await reader.cancel(); // the phone locks
  assert.equal(existsSync(marker), false, "the stand-in must still be mid-run when the client leaves");

  // The child is not killed: it runs to its own end and writes its marker.
  await until(() => existsSync(marker), "the stand-in CLI to finish after the disconnect");
  const meta = await until(() => {
    const j = readJob(jobId);
    return j && j.status !== "running" ? j : null;
  }, "the run to be finalized");

  assert.equal(meta.status, "done", JSON.stringify(meta));
  assert.equal(meta.title, "Research Acme");
  assert.match(meta.summary, /VERDICT: 3\.8\/5/);
  assert.equal(meta.tokens, 120);
  assert.equal(meta.costUsd, 0.01);

  // Reconnect from the number of records already read (keepalives excluded).
  const from = seen.filter((e) => e.type !== "keepalive").length;
  const replay = await eventsRoute.GET(
    new Request(`http://localhost/api/jobs/${jobId}/events?from=${from}`),
    { params: Promise.resolve({ id: jobId }) },
  );
  const body = await replay.json();
  assert.equal(body.running, false);
  const missed = body.events;
  assert.ok(missed.some((e) => e.type === "text" && /VERDICT/.test(e.text)), "the replay carries the text sent after the disconnect");
  assert.deepEqual(missed.at(-1), { type: "done", tokens: 120, costUsd: 0.01 });
  assert.equal(missed.filter((e) => e.type === "done" || e.type === "error").length, 1, "exactly one terminal record");

  // The whole transcript: what the client read, then what it missed, nothing twice.
  const log = readFileSync(join(dataRoot, ".career-ops-web", "jobs", `${jobId}.ndjson`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log, [...seen.filter((e) => e.type !== "keepalive"), ...missed]);
  assert.ok(!log.some((e) => e.type === "keepalive"), "keepalives never enter the transcript");

  // Finalized once: the record does not change after the run ended.
  const endedAt = meta.endedAt;
  await sleep(300);
  assert.equal(readJob(jobId).endedAt, endedAt);
});

test("a malformed client id is replaced, and the run is findable by the X-Job-Id header", async () => {
  const { POST } = await import("@/app/api/run/route.ts");
  const { readJob } = await import("@/lib/core/job-log.ts");
  rmSync(marker, { force: true });
  const res = await POST(new Request("http://localhost/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "research", input: "Acme Robotics", cliId: "claude", jobId: "../../etc/passwd" }),
  }));
  const id = res.headers.get("X-Job-Id");
  assert.match(id, /^job-\d+-[a-z0-9]+$/);
  // Read to the end this time: an attached client sees the same outcome.
  const text = await res.text();
  assert.match(text, /"type":"done"/);
  const meta = await until(() => {
    const j = readJob(id);
    return j && j.status !== "running" ? j : null;
  }, "the run to be finalized");
  assert.equal(meta.status, "done");
});
