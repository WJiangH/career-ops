// lib/agent-run.mjs — run the user's agent CLI headless, once, for a JSON answer.
//
// Mirrors the detection order in web/src/lib/clis.ts and the invocations
// AGENTS.md documents. Nothing here is specific to any prompt: a caller hands
// over a prompt and gets back the first balanced JSON object in the reply, or
// null. Auth and quota failures surface as errors with the CLI's own words,
// because these CLIs report them on stdout and a silent null would look like
// "the model had nothing to say".

import { spawnSync } from 'node:child_process';

/** Headless invocations, in detect order. */
export const CLIS = [
  { id: 'claude', bin: 'claude', args: (p) => ['-p', p] },
  { id: 'codex', bin: 'codex', args: (p) => ['exec', p] },
  { id: 'grok', bin: 'grok', args: (p) => ['-p', p] },
  { id: 'gemini', bin: 'gemini', args: (p) => ['-p', p] },
];

function which(bin) {
  return spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).status === 0;
}

/** First installed CLI, or the one named by `wantedId`; null when none is on PATH. */
export function pickCli(wantedId = null) {
  const wanted = wantedId ? CLIS.filter((c) => c.id === wantedId) : CLIS;
  if (wantedId && !wanted.length) throw new Error(`unknown --cli "${wantedId}" (known: ${CLIS.map((c) => c.id).join(', ')})`);
  return wanted.find((c) => which(c.bin)) ?? null;
}

/** First balanced {...} in a response that may carry chatter or a fence around it. */
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Run `cli` on `prompt` and return the parsed JSON object it replied with.
 * Throws on a non-zero exit, an auth failure, or a reply with no JSON.
 */
export function askAgent(cli, prompt, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  const run = spawnSync(cli.bin, cli.args(prompt), { encoding: 'utf8', maxBuffer });
  const out = `${run.stdout || ''}`;
  if (run.status !== 0) {
    throw new Error(`${cli.id} exited ${run.status}\n${[run.stderr, out].filter(Boolean).join('\n').slice(0, 1500)}`);
  }
  if (/not logged in|please run \/login|not authenticated|invalid api[- ]?key|oauth session expired/i.test(out)) {
    throw new Error(`${cli.id} is not authenticated:\n  ${out.trim().split('\n')[0]}`);
  }
  const json = extractJson(out);
  if (!json) throw new Error(`${cli.id} returned no JSON object`);
  return JSON.parse(json);
}
