import fs from "node:fs";
import path from "node:path";
// Executable lookup lives in .mjs so plain Node scripts (scan-cli-models) can
// share it rather than reimplementing PATH + PATHEXT resolution.
import { findBin, searchDirs } from "./clis-bin.mjs";
import { CLI_MODELS_CACHE, readModelCache } from "./cli-models-cache.mjs";

// Server-only (node imports). The agnostic runtimes career-ops can delegate to
// in headless mode (AGENTS.md). Install URLs from career-ops-docs.
export type CliSpec = {
  id: string;
  name: string;
  bin: string;
  run: string;
  url: string;
  /** headless invocation args for a single prompt */
  args: (prompt: string) => string[];
  /**
   * Args that ask for a structured event stream instead of plain text. Present
   * only for CLIs cli-stream.mjs can parse; without it the route falls back to
   * raw stdout, which displays fine but reports no token usage.
   */
  streamArgs?: (prompt: string) => string[];
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

export const KNOWN: CliSpec[] = [
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p],
    streamArgs: (p) => ["-p", p, "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    modelArgs: (m) => ["--model", m],
    // An unknown level here is only a warning — claude carries on with its
    // default. The other two abort the run.
    effortArgs: (e) => ["--effort", e],
    efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://github.com/openai/codex", args: (p) => ["exec", p],
    streamArgs: (p) => ["exec", "--json", p],
    modelArgs: (m) => ["--model", m],
    // No dedicated flag: effort rides on the generic config override. An
    // unsupported value fails the turn with a 400 from the API, not locally.
    effortArgs: (e) => ["-c", `model_reasoning_effort=${e}`],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  // No effort flag: gemini exposes only a model selector.
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p],
    modelArgs: (m) => ["--model", m] },
  { id: "opencode", name: "OpenCode", bin: "opencode", run: "opencode run", url: "https://opencode.ai", args: (p) => ["run", p] },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p] },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p] },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p] },
  { id: "grok", name: "Grok Build CLI", bin: "grok", run: "grok -p", url: "https://docs.x.ai/build/overview", args: (p) => ["-p", p],
    streamArgs: (p) => ["-p", p, "--output-format", "streaming-json"],
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
