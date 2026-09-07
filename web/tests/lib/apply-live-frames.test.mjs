// tests/lib/apply-live-frames.test.mjs — the apply extractor must never touch a
// frame that cannot answer. Cloudflare's challenge loader leaves an empty-URL
// frame on branded career pages (coreweave.com); a Playwright call on it hangs
// forever, which is how "Reading your form…" got stuck on every CoreWeave role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveFrames, withTimeout } from "../../src/lib/apply/frames.mjs";

const frame = (url, detached = false) => ({ url: () => url, isDetached: () => detached });
const page = (frames) => ({ frames: () => frames });

test("liveFrames drops empty-URL and about:blank frames, keeps real ones", () => {
  const main = frame("https://coreweave.com/careers/job?123");
  const embed = frame("https://job-boards.greenhouse.io/embed/job_app?for=coreweave");
  const ghost = frame("");
  const blank = frame("about:blank");
  assert.deepEqual(liveFrames(page([main, blank, ghost, embed])), [main, embed]);
});

test("liveFrames drops detached frames and frames whose url() throws", () => {
  const ok = frame("https://x/a");
  const gone = frame("https://x/b", true);
  const throwing = { url: () => { throw new Error("detached"); }, isDetached: () => false };
  assert.deepEqual(liveFrames(page([ok, gone, throwing])), [ok]);
});

test("withTimeout rejects a hung call with a named error and clears its timer", async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 20, "extractForm"), /extractForm timed out after 20ms/);
  assert.equal(await withTimeout(Promise.resolve(7), 50, "fast"), 7);
});
