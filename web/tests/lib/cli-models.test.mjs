// Tests for cli-models.mjs — discovering what each CLI can actually run.
//
// Fixtures are real output captured on 2026-08-11. Each source was chosen only
// after the obvious one failed, and the tests record why:
//   - `codex models` opens an interactive picker and never returns in a pipe
//   - there is no `claude models` subcommand; asking sends "models" as a prompt
//   - `gemini models` fails auth entirely on some accounts
//
// Run:  node --test tests/lib/cli-models.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexCache, parseGrokModels, parseClaudeHelpModels, discoverModels, MODEL_SOURCES } from "../../src/lib/cli-models.mjs";

// ── codex ────────────────────────────────────────────────────────────────────

const CODEX_CACHE = JSON.stringify({
  fetched_at: "2026-08-10T23:11:00Z",
  etag: "abc",
  models: [
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    { slug: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
  ],
});

test("codex: slugs come out of the cache codex maintains itself", () => {
  assert.deepEqual(parseCodexCache(CODEX_CACHE), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
});

test("codex: a half-written or missing cache yields nothing, not a throw", () => {
  for (const junk of ["", "{", "null", "[]", '{"models":"nope"}']) {
    assert.deepEqual(parseCodexCache(junk), [], `choked on ${JSON.stringify(junk)}`);
  }
});

// ── grok ─────────────────────────────────────────────────────────────────────

const GROK_OUT = `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
`;

test("grok: only lines under the Available header count", () => {
  // "Default model: grok-4.5" sits ABOVE the header and names the same model;
  // reading the whole output would report it twice, or report a phantom entry
  // when the default is not in the list.
  assert.deepEqual(parseGrokModels(GROK_OUT), ["grok-4.5"]);
});

test("grok: several models, and the (default) marker is not part of the name", () => {
  const out = "Available models:\n  * grok-4.5 (default)\n  * grok-4-fast\n  grok-3\n";
  assert.deepEqual(parseGrokModels(out), ["grok-4.5", "grok-4-fast", "grok-3"]);
});

test("grok: the list ends at the first dedented line", () => {
  const out = "Available models:\n  * grok-4.5\n\nSomething else entirely\n  not-a-model\n";
  assert.deepEqual(parseGrokModels(out), ["grok-4.5"]);
});

test("grok: no header means no models", () => {
  assert.deepEqual(parseGrokModels("You are not logged in.\n"), []);
  assert.deepEqual(parseGrokModels(""), []);
});

// ── claude ───────────────────────────────────────────────────────────────────

const CLAUDE_HELP = `  --mcp-config <configs...>             Load MCP servers from JSON
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
  --settings <file-or-json>             Path to a settings JSON file, e.g. 'foo'
`;

test("claude: aliases are lifted out of the --model description", () => {
  // The only machine-readable list claude offers — there is no `claude models`.
  assert.deepEqual(parseClaudeHelpModels(CLAUDE_HELP), ["fable", "opus", "sonnet", "claude-fable-5"]);
});

test("claude: quotes elsewhere in a long help text cannot leak in", () => {
  // 'foo' belongs to --settings, two flags later.
  assert.ok(!parseClaudeHelpModels(CLAUDE_HELP).includes("foo"));
});

test("claude: a help text without the flag yields nothing", () => {
  assert.deepEqual(parseClaudeHelpModels("usage: claude [options]\n"), []);
});

// ── discovery ────────────────────────────────────────────────────────────────

const io = (over = {}) => ({
  readFile: () => CODEX_CACHE,
  runCommand: (bin) => (bin === "grok" ? GROK_OUT : CLAUDE_HELP),
  findBin: () => "/usr/local/bin/x",
  home: "/home/u",
  ...over,
});

test("every CLI with a source is reported", () => {
  const r = discoverModels(io());
  assert.deepEqual(Object.keys(r).sort(), Object.keys(MODEL_SOURCES).sort());
  assert.equal(r.codex.models.length, 3);
  assert.deepEqual(r.grok.models, ["grok-4.5"]);
});

test("a CLI that is not installed says so instead of erroring out", () => {
  const r = discoverModels(io({ findBin: () => null }));
  assert.deepEqual(r.grok.models, []);
  assert.equal(r.grok.error, "not installed");
  assert.equal(r.codex.models.length, 3, "a file source does not need the binary");
});

test("one failing source does not abort the others", () => {
  const r = discoverModels(io({ readFile: () => { throw new Error("ENOENT: no such file"); } }));
  assert.deepEqual(r.codex.models, []);
  assert.match(r.codex.error, /ENOENT/);
  assert.deepEqual(r.grok.models, ["grok-4.5"], "grok still scanned");
});

test("a CLI with no known source is reported, not omitted", () => {
  // "Nothing found" and "never looked" are different answers and the caller
  // has to be able to tell them apart.
  const r = discoverModels(io(), ["gemini"]);
  assert.deepEqual(r.gemini.models, []);
  assert.equal(r.gemini.source, "none");
  assert.match(r.gemini.error, /no known way/);
});

test("the file source is resolved against home, not cwd", () => {
  let seen = "";
  discoverModels(io({ readFile: (p) => { seen = p; return CODEX_CACHE; } }), ["codex"]);
  assert.equal(seen, "/home/u/.codex/models_cache.json");
});
