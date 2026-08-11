// Tests for cli-stream.mjs — the per-CLI event dialects.
//
// Every fixture below is a real line captured from the actual CLI on 2026-08-11,
// not a guess at the schema. The token arithmetic in particular cannot be
// reasoned out from field names alone: whether `input_tokens` already contains
// the cached portion differs between vendors, and getting it wrong produces a
// plausible number rather than an error.
//
// Run:  node --test tests/lib/cli-stream.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaude, parseGrok, parseCodex, parserFor, describeToolInput } from "../../src/lib/cli-stream.mjs";

/** All events of one type, for terser assertions. */
const only = (events, type) => events.filter((e) => e.type === type);

// ── Claude ───────────────────────────────────────────────────────────────────

test("claude: text deltas become text", () => {
  const ev = { type: "stream_event", event: { type: "content_block_delta", delta: { text: "Hello" } } };
  assert.deepEqual(parseClaude(ev), [{ type: "text", text: "Hello" }]);
});

test("claude: tool calls come from the assistant event, with their argument", () => {
  // Verbatim shape from a live run. content_block_start is NOT used: there the
  // input is still {} and the arguments stream in afterwards as
  // input_json_delta, so a parser reading it can never name the file.
  const ev = {
    type: "assistant",
    message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/home/dev/career-ops/modes/oferta.md" } }] },
  };
  assert.deepEqual(parseClaude(ev), [{ type: "tool", name: "Read", detail: "modes/oferta.md" }]);
});

test("claude: content_block_start no longer emits a tool", () => {
  // Otherwise every tool would be reported twice — once bare, once with detail.
  const ev = { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read", input: {} } } };
  assert.deepEqual(parseClaude(ev), []);
});

test("claude: the assistant event does not re-emit text", () => {
  // Text already arrives as deltas; taking both would duplicate every answer.
  const ev = { type: "assistant", message: { content: [{ type: "text", text: "career-ops" }] } };
  assert.deepEqual(parseClaude(ev), []);
});

test("claude: thinking blocks are not tools", () => {
  const ev = { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } };
  assert.deepEqual(parseClaude(ev), []);
});

test("claude: usage excludes cache reads", () => {
  const ev = {
    type: "result",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 5 },
    total_cost_usd: 0.0125,
  };
  // 9000 cached reads are the discounted path; counting them would make a
  // well-cached run look more expensive than a cold one.
  assert.deepEqual(parseClaude(ev), [{ type: "usage", tokens: 125, costUsd: 0.0125 }]);
});

test("claude: a result without a cost reports null, not zero", () => {
  const ev = { type: "result", usage: { input_tokens: 10, output_tokens: 1 } };
  assert.equal(parseClaude(ev)[0].costUsd, null, "zero would read as a free run");
});

// ── Grok ─────────────────────────────────────────────────────────────────────

test("grok: text events carry `data`, not `text`", () => {
  assert.deepEqual(parseGrok({ type: "text", data: "HI" }), [{ type: "text", text: "HI" }]);
});

test("grok: reasoning is not answer text", () => {
  // `thought` is chain-of-thought. Emitting it would put reasoning in the report
  // pane AND set emittedText for a run that never answered — defeating the
  // route's honesty gate.
  assert.deepEqual(parseGrok({ type: "thought", data: "The user wants..." }), []);
});

test("grok: the tool manifest is dropped", () => {
  // available_commands is multi-kilobyte and repeats on every turn.
  assert.deepEqual(parseGrok({ type: "available_commands", tools: ["read_file"], commands: [] }), []);
});

test("grok: tool_call reports the tool name and its target", () => {
  const ev = { type: "tool_call", toolCallId: "call-1", title: "read_file", toolName: "read_file", status: "pending", rawInput: { target_file: "/home/dev/career-ops/package.json", limit: 30 } };
  assert.deepEqual(parseGrok(ev), [{ type: "tool", name: "read_file", detail: "career-ops/package.json" }]);
});

test("grok: the web-search label loses its dangling colon", () => {
  // grok's own toolName is literally "Web search:" — fine in its TUI, dangling
  // in a line that reads "Using Web search:". rawInput carries no query.
  const ev = { type: "tool_call", title: "Web search:", toolName: "Web search:", kind: "search", rawInput: { variant: "WebSearch", backend: true } };
  assert.deepEqual(parseGrok(ev), [{ type: "tool", name: "Web search" }]);
});

test("grok: end carries the turn total and a real cost", () => {
  // Verbatim from a live run. The arithmetic that proves input_tokens EXCLUDES
  // cache reads: 18575 + 32 + 5376 + 0 == 23983 == grok's own total_tokens.
  const ev = {
    type: "end",
    stopReason: "end_turn",
    usage: { input_tokens: 18575, cache_read_input_tokens: 5376, cache_creation_input_tokens: 0, output_tokens: 32, reasoning_tokens: 27, total_tokens: 23983 },
    total_cost_usd: 0.0389548,
  };
  assert.deepEqual(parseGrok(ev), [{ type: "usage", tokens: 18607, costUsd: 0.0389548 }]);
  assert.notEqual(parseGrok(ev)[0].tokens, 23983, "total_tokens includes discounted cache reads");
});

test("grok: intermediate usage is emitted too", () => {
  // So a run killed before `end` still records something rather than zero.
  const ev = { type: "usage", usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0 } };
  assert.deepEqual(only(parseGrok(ev), "usage"), [{ type: "usage", tokens: 105, costUsd: null }]);
});

// ── Codex ────────────────────────────────────────────────────────────────────

test("codex: the answer arrives whole, in a completed agent_message", () => {
  const ev = { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "career-ops" } };
  assert.deepEqual(parseCodex(ev), [{ type: "text", text: "career-ops" }]);
});

test("codex: non-message items are tool activity, with the command unwrapped", () => {
  // Codex routes everything through a login shell; the wrapper repeats on every
  // line and the command inside is the actual information.
  const ev = { type: "item.started", item: { id: "item_0", type: "command_execution", command: "/bin/bash -lc 'node doctor.mjs --json'" } };
  assert.deepEqual(parseCodex(ev), [{ type: "tool", name: "command_execution", detail: "node doctor.mjs --json" }]);
});

test("codex: a completed command is not re-reported as a tool", () => {
  // item.started already announced it; item.completed would double it.
  const ev = { type: "item.completed", item: { id: "item_0", type: "command_execution", exit_code: 0 } };
  assert.deepEqual(parseCodex(ev), []);
});

test("codex: cached input is SUBTRACTED, not added", () => {
  // The vendor difference that makes a shared formula wrong. OpenAI's
  // input_tokens already contains cached_input_tokens, so adding them
  // double-counts: this run is 19136 fresh + 593 out, not 84497.
  const ev = { type: "turn.completed", usage: { input_tokens: 83904, cached_input_tokens: 64768, output_tokens: 593, reasoning_output_tokens: 364 } };
  assert.deepEqual(parseCodex(ev), [{ type: "usage", tokens: 19729, costUsd: null }]);
});

test("codex: cost is null, never invented", () => {
  const ev = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } };
  assert.equal(parseCodex(ev)[0].costUsd, null, "codex reports no cost; a guessed rate would be fiction");
});

test("codex: a malformed usage block cannot go negative", () => {
  const ev = { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 900, output_tokens: 1 } };
  assert.equal(parseCodex(ev)[0].tokens, 1);
});

// ── shared robustness ────────────────────────────────────────────────────────

for (const [name, parse] of [["claude", parseClaude], ["grok", parseGrok], ["codex", parseCodex]]) {
  test(`${name}: unknown and malformed events are ignored, not thrown on`, () => {
    // A CLI adding an event type in a future release must not kill a live run.
    for (const junk of [null, undefined, 42, "text", [], {}, { type: "some.future.event" }]) {
      assert.deepEqual(parse(junk), [], `${name} choked on ${JSON.stringify(junk)}`);
    }
  });

  test(`${name}: a usage event with no counts reports 0, not NaN`, () => {
    const ev = name === "claude" ? { type: "result", usage: {} }
      : name === "grok" ? { type: "end", usage: {} }
        : { type: "turn.completed", usage: {} };
    assert.equal(parse(ev)[0].tokens, 0);
  });
}

// ── failures that arrive on stdout ───────────────────────────────────────────
//
// The route watches stderr for failures. Both of these come down stdout instead,
// so before this they were dropped and the run failed later with the generic
// "produced no output" — hiding the actual reason.

test("claude: an auth failure in a result event surfaces as an error", () => {
  // Verbatim from a run with no token: is_error rides on a normal result line.
  const ev = { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", usage: {} };
  const out = parseClaude(ev);
  assert.deepEqual(only(out, "error"), [{ type: "error", msg: "Not logged in · Please run /login" }]);
  assert.equal(only(out, "usage").length, 1, "usage is still reported alongside");
});

test("claude: a successful result reports no error", () => {
  const ev = { type: "result", is_error: false, result: "career-ops", usage: { input_tokens: 5, output_tokens: 1 } };
  assert.deepEqual(only(parseClaude(ev), "error"), []);
});

test("codex: an API rejection is unwrapped to its sentence", () => {
  // Codex nests the upstream error as a JSON string inside its own event; the
  // raw blob would put three lines of escaped JSON where one sentence belongs.
  const inner = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "[reasoning.effort] Invalid value: 'bogus'." } });
  assert.deepEqual(parseCodex({ type: "error", message: inner }), [{ type: "error", msg: "[reasoning.effort] Invalid value: 'bogus'." }]);
});

test("codex: turn.failed is an error too", () => {
  assert.deepEqual(parseCodex({ type: "turn.failed", error: { message: "quota exceeded" } }), [{ type: "error", msg: "quota exceeded" }]);
});

test("codex: a non-JSON error message is passed through as-is", () => {
  assert.deepEqual(parseCodex({ type: "error", message: "connection reset" }), [{ type: "error", msg: "connection reset" }]);
});

test("codex: an error with no message still says something", () => {
  assert.equal(parseCodex({ type: "error" })[0].msg, "the CLI reported an error");
});

// ── tool detail ──────────────────────────────────────────────────────────────

test("detail: an absolute path keeps only its meaningful tail", () => {
  assert.equal(describeToolInput({ file_path: "/home/dev/career-ops/modes/oferta.md" }), "modes/oferta.md");
  assert.equal(describeToolInput({ path: "/etc/hosts" }), "/etc/hosts", "already short enough to keep whole");
  assert.equal(describeToolInput({ file_path: "portals.yml" }), "portals.yml", "a relative path is left alone");
});

test("detail: shell wrappers are unwrapped, single or double quoted", () => {
  assert.equal(describeToolInput({ command: `/bin/bash -lc 'node merge-tracker.mjs'` }), "node merge-tracker.mjs");
  assert.equal(describeToolInput({ command: `bash -c "ls -la"` }), "ls -la");
  assert.equal(describeToolInput({ command: "node scan.mjs --dry-run" }), "node scan.mjs --dry-run", "an unwrapped command is untouched");
});

test("detail: keys are tried in priority order", () => {
  assert.equal(describeToolInput({ query: "q", file_path: "a/b.md" }), "a/b.md", "the path is more identifying than the query");
});

test("detail: long values are truncated with an ellipsis", () => {
  const out = describeToolInput({ command: "x".repeat(200) });
  assert.equal(out.length, 72);
  assert.ok(out.endsWith("…"));
});

test("detail: newlines never break the single-line layout", () => {
  assert.equal(describeToolInput({ command: "line one\n  line two" }), "line one line two");
});

test("detail: an unrecognised shape yields nothing rather than a random field", () => {
  assert.equal(describeToolInput({ mysteryOption: "value", backend: true }), "");
  assert.equal(describeToolInput({ file_path: "   " }), "", "blank is not a detail");
  for (const junk of [null, undefined, "str", 42, []]) assert.equal(describeToolInput(junk), "");
});

test("detail: a tool with no readable argument omits the key entirely", () => {
  const [ev] = parseCodex({ type: "item.started", item: { type: "web_search" } });
  assert.deepEqual(ev, { type: "tool", name: "web_search" }, "no empty-string detail to render");
});

// ── registry ─────────────────────────────────────────────────────────────────

test("parserFor resolves the CLIs with a structured mode", () => {
  assert.equal(parserFor("claude"), parseClaude);
  assert.equal(parserFor("grok"), parseGrok);
  assert.equal(parserFor("codex"), parseCodex);
});

test("parserFor returns null for text-only CLIs", () => {
  // null is meaningful: the route falls back to raw stdout passthrough.
  for (const id of ["gemini", "qwen", "copilot", "antigravity"]) {
    assert.equal(parserFor(id), null, `${id} has no structured mode wired`);
  }
});

test("parserFor is not fooled by inherited Object properties", () => {
  assert.equal(parserFor("constructor"), null);
  assert.equal(parserFor("toString"), null);
});
