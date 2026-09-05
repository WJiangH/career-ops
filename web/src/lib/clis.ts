import fs from "node:fs";
import path from "node:path";
// Executable lookup lives in .mjs so plain Node scripts (scan-cli-models) can
// share it rather than reimplementing PATH + PATHEXT resolution.
import { findBin, searchDirs } from "./clis-bin.mjs";
import { CLI_MODELS_CACHE, readModelCache } from "./cli-models-cache.mjs";
import { codexStreamArgs, isFatalClaudeStderr, isFatalCodexStderr, parseClaudeEvent, parseCodexEvent, parseGrokEvent } from "./run-cli-support.mjs";

// Server-only (node imports). The agnostic runtimes career-ops can delegate to
// in headless mode (AGENTS.md). Install URLs from career-ops-docs.
export type CliSpec = {
  id: string;
  name: string;
  bin: string;
  run: string;
  url: string;
  /** headless invocation args for a single prompt, emitting PLAIN TEXT on stdout.
   * Every caller that reads the output itself (the `<<offer:>>`/`<<cv:>>` envelope
   * routes, the apply planners) uses this, so it must stay unstructured. */
  args: (prompt: string) => string[];
  /** Structured-output CLIs only: args for a run whose stdout the caller parses
   * with `parseEvent` — i.e. /api/run's dashboard stream, the one consumer that
   * understands events. Absent → that caller falls back to `args`.
   *
   * INVARIANT: `parseEvent` only applies to output produced by THIS argv (for
   * claude, by claude-invocation.mjs's `claudeCliArgs`, which spells its own
   * `--output-format stream-json`). Pairing one CLI's parser with a plain-text
   * invocation yields a silent stream of unparseable lines. */
  streamArgs?: (prompt: string) => string[];
  /** Structured-output CLIs only: parse one stdout line into dashboard events.
   * Absent → the route streams stdout as raw text (the default for every CLI
   * without its own structured output format). */
  parseEvent?: (line: string) => import("./run-cli-support.mjs").ParsedEvent | null;
  /** Structured-output CLIs only: decide whether a stderr line is fatal.
   * Absent → the route falls back to the shared generic error regex. */
  stderrIsFatal?: (line: string) => boolean;
  /** Args selecting a model. Absent when the CLI exposes no such flag. */
  modelArgs?: (model: string) => string[];
  /** Args selecting reasoning effort. */
  effortArgs?: (effort: string) => string[];
  /**
   * Effort levels this CLI accepts. Each list was read off the CLI itself
   * (`--help`, or the error text from a deliberately invalid value) rather than
   * assumed — they genuinely differ, and two of the three reject an unknown
   * level outright instead of falling back to a default.
   */
  efforts?: string[];
};

/**
 * NO RUNTIME HERE MAY GRANT ITSELF MORE PERMISSION THAN THE AUDITED ONE.
 *
 * The permission model is per-worker AND per-CLI, but only one axis is written
 * down: WRITE_CAPABLE_TOOLS and the per-kind deny lists live in
 * claude-invocation.mjs — i.e. on Claude's path. A new CLI arriving with a
 * blanket auto-approve flag (`--always-approve`, `--yolo`,
 * `--dangerously-skip-permissions`, `--yes`) is not breaking that rule; it is
 * entering where the rule does not exist.
 *
 * Concretely: the `pdf` worker has Bash explicitly denied and must never regain
 * it. Pair Grok with `--always-approve` and that same worker gets Write and
 * Bash auto-approved — so the user's choice of runtime silently changes what a
 * worker may do to their files, while both paths look identical in the UI.
 *
 * If a CLI has no per-tool deny list to pair with, the answer is NOT to
 * auto-approve: it is to withhold the workers that write. Needing such a flag
 * to make a runtime work is a core architecture issue, not a line inside a
 * CLI-support PR.
 *
 * Enforced by tests/lib/clis-permissions.test.mjs, because a rule that only
 * lives in a comment is a rule the next contributor may never read.
 */
export const KNOWN: CliSpec[] = [
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p], parseEvent: parseClaudeEvent, stderrIsFatal: isFatalClaudeStderr,
    modelArgs: (m) => ["--model", m],
    // An unknown level here is only a warning — claude carries on with its
    // default. The other two abort the run.
    effortArgs: (e) => ["--effort", e],
    efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://github.com/openai/codex", args: (p) => ["exec", p], streamArgs: codexStreamArgs, parseEvent: parseCodexEvent, stderrIsFatal: isFatalCodexStderr,
    modelArgs: (m) => ["--model", m],
    // No dedicated flag: effort rides on the generic config override. An
    // unsupported value fails the turn with a 400 from the API, not locally.
    effortArgs: (e) => ["-c", `model_reasoning_effort=${e}`],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p],
    // No effort flag: gemini exposes only a model selector.
    modelArgs: (m) => ["--model", m] },
  { id: "opencode", name: "OpenCode", bin: "opencode", run: "opencode run", url: "https://opencode.ai", args: (p) => ["run", p] },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p] },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p] },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p] },
  // Grok Build speaks its own `--output-format streaming-json` schema, not
  // Claude's `stream-json`. It has a parser of its own now, so it streams
  // structured like the other two rather than falling through to raw stdout —
  // which displayed fine and recorded `tokens: 0` on every grok run.
  { id: "grok", name: "Grok Build CLI", bin: "grok", run: "grok -p", url: "https://docs.x.ai/build/overview", args: (p) => ["-p", p], streamArgs: (p) => ["-p", p, "--output-format", "streaming-json"], parseEvent: parseGrokEvent,
    modelArgs: (m) => ["--model", m],
    // Rejects anything outside this set with a non-zero exit before any work.
    effortArgs: (e) => ["--reasoning-effort", e],
    efforts: ["low", "medium", "high"] },
];

export function detectClis(root?: string) {
  const dirs = searchDirs();
  // Models come from the cache scan-cli-models.mjs writes, never from a list
  // hardcoded here: the sets move when a vendor ships a tier or you switch
  // accounts. A missing cache just means no model picker yet.
  const cached = readModelCache(root) as { clis?: Record<string, { models?: string[] }> } | null;
  return KNOWN.map((c) => {
    const found = findBin(c.bin, dirs);
    const models = cached?.clis?.[c.id]?.models ?? [];
    return {
      id: c.id, name: c.name, run: c.run, url: c.url, installed: !!found, path: found,
      // A single model is not a choice — the picker hides rather than showing a
      // dropdown you cannot change. Deciding that here keeps the rule in one
      // place instead of duplicated in the UI.
      models: c.modelArgs && models.length > 1 ? models : [],
      efforts: c.efforts ?? [],
    };
  });
}

export function resolveCli(id: string): { spec: CliSpec; binPath: string } | null {
  const spec = KNOWN.find((c) => c.id === id);
  if (!spec) return null;
  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  return { spec, binPath };
}

export { findBin };
