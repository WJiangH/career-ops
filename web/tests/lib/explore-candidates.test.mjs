// tests/lib/explore-candidates.test.mjs — `candidates` in the Explorer filter
// contract: AI-suggested keywords the user has not promoted. They ride the URL
// codec (a search stays shareable), merge/replace through parseExplorePatch
// like the other lists, and default to empty so older callers are unaffected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTERS, filtersToParams, paramsToFilters, parseExplorePatch } from "../../src/lib/explore.ts";

test("candidates default to an empty list", () => {
  assert.deepEqual(DEFAULT_FILTERS.candidates, []);
});

test("URL codec round-trips candidates under `cand`", () => {
  const f = { ...DEFAULT_FILTERS, positive: ["Inference"], candidates: ["Research Scientist", "CUDA"] };
  const qs = filtersToParams(f);
  assert.match(qs, /cand=Research\+Scientist%2CCUDA/);
  const back = paramsToFilters(new URLSearchParams(qs));
  assert.deepEqual(back.candidates, ["Research Scientist", "CUDA"]);
  assert.deepEqual(back.positive, ["Inference"]);
});

test("no `cand` param means no candidates, not a crash", () => {
  const back = paramsToFilters(new URLSearchParams("q=Inference"));
  assert.deepEqual(back.candidates, []);
});

test("parseExplorePatch replaces or merges candidates like every other list", () => {
  const base = { ...DEFAULT_FILTERS, candidates: ["CUDA"] };
  assert.deepEqual(parseExplorePatch({ candidates: ["RTL"] }, base).candidates, ["RTL"]);
  assert.deepEqual(parseExplorePatch({ candidates: ["RTL"] }, base, true).candidates, ["CUDA", "RTL"]);
  assert.deepEqual(parseExplorePatch({ positive: ["Kernel"] }, base).candidates, ["CUDA"]);
});
