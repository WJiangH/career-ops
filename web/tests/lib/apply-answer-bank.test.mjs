// tests/lib/apply-answer-bank.test.mjs — the web side of the answer bank:
// company scoping from the form title, the verbatim prompt block, and the
// overlay that lets the candidate's standing answers outrank the planner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyFromTitle, bankMemoryBlock, overlayBank } from "../../src/lib/apply/answer-bank-pure.mjs";

test("companyFromTitle reads Greenhouse and Ashby title shapes", () => {
  assert.equal(companyFromTitle("Job Application for TPU Kernel Engineer at Anthropic"), "Anthropic");
  assert.equal(companyFromTitle("Applied ML Engineer @ Deepgram"), "Deepgram");
  assert.equal(companyFromTitle("Careers"), null);
});

const m = {
  auto: [{ id: "f2", label: "Do you require visa sponsorship?", entry: "sponsorship", hit: true, level: "auto", answer: "Yes", status: "answered", confirm_each_time: false }],
  confirm: [{ id: "f4", label: "Are you open to relocation for this role?", entry: "open-relocation", hit: true, level: "auto", answer: "Based in San Jose, CA", status: "answered", confirm_each_time: true }],
  unknown: [{ id: "f6", label: "Why do you want to work here?", entry: null, hit: false }],
};

test("bankMemoryBlock lists standing answers verbatim and flags confirm-each-time", () => {
  const b = bankMemoryBlock(m);
  assert.match(b, /VERBATIM/);
  assert.match(b, /Do you require visa sponsorship\? → "Yes"/);
  assert.match(b, /relocation.*confirms each time/);
  assert.equal(bankMemoryBlock({ auto: [], confirm: [], unknown: m.unknown }), "");
});

test("overlayBank overwrites planner guesses for auto hits and marks confirm hits", () => {
  const answers = { f2: { value: "No", needs_confirmation: true }, f4: { value: "", needs_confirmation: true }, f6: { value: "Because…", needs_confirmation: false } };
  const n = overlayBank(answers, m);
  assert.deepEqual(n, { auto: 1, confirm: 1 });
  assert.deepEqual(answers.f2, { value: "Yes", needs_confirmation: false });
  assert.deepEqual(answers.f4, { value: "Based in San Jose, CA", needs_confirmation: true });
  assert.deepEqual(answers.f6, { value: "Because…", needs_confirmation: false });
});
