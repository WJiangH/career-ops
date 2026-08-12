// Tests for profileTargetKeywords() — reading `target_roles` out of a parsed
// config/profile.yml.
//
// The bug this module was extracted for was not a crash: the inline version
// read both fields with the wrong shape and returned [], so the Explorer's
// profile.yml fallback looked implemented and had never once produced a
// keyword. So the tests that matter here are the SHAPE tests, driven by the
// two shapes that actually exist on disk — the shipped example, and what the
// app's own writer emits.
//
// Run:  node --test tests/lib/profile-keywords.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { profileTargetKeywords } from "../../src/lib/profile-keywords.mjs";

// ── the shapes that exist on disk ────────────────────────────────────────────

test("the shipped config/profile.example.yml yields its roles", () => {
  // Not a synthetic fixture: if the template's shape changes, this fails here
  // rather than silently emptying the fallback again.
  const doc = yaml.load(readFileSync(new URL("../../../config/profile.example.yml", import.meta.url), "utf8"));
  const kws = profileTargetKeywords(doc);
  assert.ok(kws.length >= 2, `expected the template's roles, got ${JSON.stringify(kws)}`);
  for (const k of kws) assert.equal(typeof k, "string");
  // primary[] must be represented — the field the inline version read as a string.
  for (const p of doc.target_roles.primary) assert.ok(kws.includes(p), `missing primary role: ${p}`);
  // …and archetypes must contribute their NAME, not the object.
  for (const a of doc.target_roles.archetypes) assert.ok(kws.includes(a.name), `missing archetype: ${a.name}`);
});

test("primary is a LIST, not a string — the regression", () => {
  // api/profile/route.ts writes `{ primary: roles.slice(0, 6) }`. The inline
  // version tested `typeof roles.primary === "string"`, so the app could not
  // read back the profile it had just written.
  const kws = profileTargetKeywords({ target_roles: { primary: ["ML Engineer", "Inference Engineer"] } });
  assert.deepEqual(kws, ["ML Engineer", "Inference Engineer"]);
});

test("archetypes contribute .name, not the whole object", () => {
  const kws = profileTargetKeywords({
    target_roles: { archetypes: [{ name: "Edge AI Engineer", level: "Senior", fit: "primary" }] },
  });
  assert.deepEqual(kws, ["Edge AI Engineer"]);
});

test("primary and archetypes combine, primary first", () => {
  const kws = profileTargetKeywords({
    target_roles: { primary: ["A"], archetypes: [{ name: "B" }] },
  });
  assert.deepEqual(kws, ["A", "B"]);
});

// ── never throws: this is a tolerant seeding path, not a validator ───────────

test("malformed or missing input yields [] rather than throwing", () => {
  for (const bad of [
    null,
    undefined,
    {},
    "a string",
    42,
    { target_roles: null },
    { target_roles: "roles" },
    { target_roles: [] }, // an array IS an object — must not blow up on .primary
    { target_roles: { primary: "Senior AI Engineer" } }, // scalar, not the documented list
    { target_roles: { primary: null, archetypes: null } },
  ]) {
    assert.deepEqual(profileTargetKeywords(bad), [], `not [] for ${JSON.stringify(bad)}`);
  }
});

test("non-string entries are dropped, not passed through", () => {
  // An archetype with no name, or a primary list someone hand-edited into
  // objects, must not put `undefined`/`{}` into a keyword list that gets
  // serialized into YAML and handed to the scanner.
  const kws = profileTargetKeywords({
    target_roles: {
      primary: ["Good", null, 42, { name: "nope" }],
      archetypes: [{ name: "Also Good" }, { level: "Senior" }, null, "bare string"],
    },
  });
  assert.deepEqual(kws, ["Good", "Also Good"]);
});

// ── parity with the core helper ──────────────────────────────────────────────

test("matches providers/_profile-keywords.mjs on the same input", async () => {
  // The module exists because a hand-written copy drifted. Assert the parity
  // directly against the core's implementation — the test runs under plain
  // Node, so the root import Turbopack refuses at build time is available here.
  const { profileTargetKeywords: core } = await import("../../../providers/_profile-keywords.mjs");
  const doc = yaml.load(readFileSync(new URL("../../../config/profile.example.yml", import.meta.url), "utf8"));
  // The core de-dupes and trims; this one returns raw strings for the caller's
  // cleanChips to handle. Compare as sets so the contract compared is "the same
  // keywords", not "the same post-processing".
  assert.deepEqual(new Set(profileTargetKeywords(doc)), new Set(core(doc)));
});
