/**
 * cli-models.mjs — discover which models each agent CLI can actually run.
 *
 * The Config model picker needs a list, and there is no shared way to get one:
 * no two CLIs expose their models the same way, and one of the three cannot be
 * asked at all without a terminal. Hardcoding a list would be stale within a
 * week, so each CLI gets a source descriptor here and `scan-cli-models.mjs`
 * re-runs the lot on demand.
 *
 * What each source is, and why:
 *
 *   codex   ~/.codex/models_cache.json — the file codex itself maintains.
 *           `codex models` opens an interactive picker and never returns in a
 *           pipe, so the cache is the only scriptable route. 9 models.
 *   grok    `grok models` — prints a plain list and exits. 1 model on a
 *           grok.com login, which is why the picker hides rather than offering
 *           a dropdown of one.
 *   claude  `claude --help` — there is no `claude models` subcommand (asking
 *           for one just sends "models" to the model as a prompt). The aliases
 *           are quoted in the --model description, which is the only
 *           machine-readable list the CLI offers. Best-effort by nature.
 *   gemini  none known. Reported as unavailable rather than guessed at.
 *
 * Parsers are pure and take raw text; the IO lives in discoverModels() behind
 * injectable readers, so the whole matrix is testable offline.
 */

/** Deduped, order-preserving, blank-free. */
function clean(list) {
  const out = [];
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * codex — the JSON cache codex writes next to its config.
 *
 * @param {string} text - Raw file contents.
 * @returns {string[]} Model slugs.
 */
export function parseCodexCache(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const models = Array.isArray(doc?.models) ? doc.models : [];
  return clean(models.map((m) => (typeof m === 'string' ? m : m?.slug ?? m?.id)));
}

/**
 * grok — `grok models`.
 *
 *   Available models:
 *     * grok-4.5 (default)
 *
 * Only lines after the "Available models:" header are taken, so the
 * "Default model: X" line above it cannot be read as a second entry.
 *
 * @param {string} text - Raw stdout.
 * @returns {string[]}
 */
export function parseGrokModels(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => /available models/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break; // dedented → the list is over
    const m = line.match(/^\s*\*?\s*([A-Za-z0-9][\w.:-]*)/);
    if (m) out.push(m[1]);
  }
  return clean(out);
}

/**
 * claude — the aliases quoted in `claude --help`'s --model description.
 *
 * Scoped to that description so quoted strings elsewhere in a 300-line help
 * text cannot leak in. Fragile by construction: it parses prose because the
 * CLI offers nothing better.
 *
 * @param {string} text - Raw `claude --help` output.
 * @returns {string[]}
 */
export function parseClaudeHelpModels(text) {
  const help = String(text ?? '');
  const start = help.indexOf('--model <model>');
  if (start === -1) return [];
  // The description runs until the next flag at the start of a line.
  const rest = help.slice(start + 1);
  const end = rest.search(/\n\s{0,4}-{1,2}[A-Za-z]/);
  const block = end === -1 ? rest : rest.slice(0, end);
  return clean([...block.matchAll(/'([A-Za-z][\w.-]{2,})'/g)].map((m) => m[1]));
}

/**
 * Where each CLI's model list comes from. `kind` tells the runner whether to
 * read a file or run a command; anything absent here simply has no source.
 */
export const MODEL_SOURCES = {
  codex: { kind: 'file', path: '.codex/models_cache.json', fromHome: true, parse: parseCodexCache },
  grok: { kind: 'command', bin: 'grok', args: ['models'], parse: parseGrokModels },
  claude: { kind: 'command', bin: 'claude', args: ['--help'], parse: parseClaudeHelpModels },
};

/**
 * Run every source and return {cliId: {models, source, error}}.
 *
 * A CLI that is not installed, has no source, or whose source fails is
 * reported with an empty list and a reason — never omitted, so the caller can
 * tell "nothing found" from "never looked".
 *
 * @param {object} io
 * @param {(p: string) => string} io.readFile - Throws if unreadable.
 * @param {(bin: string, args: string[]) => string} io.runCommand - Throws on failure.
 * @param {(bin: string) => string|null} io.findBin
 * @param {string} io.home
 * @param {string[]} [ids] - Which CLIs to scan; defaults to all with a source.
 */
export function discoverModels({ readFile, runCommand, findBin, home }, ids = Object.keys(MODEL_SOURCES)) {
  /** @type {Record<string, {models: string[], source: string, error?: string}>} */
  const out = {};
  for (const id of ids) {
    const src = MODEL_SOURCES[id];
    if (!src) {
      out[id] = { models: [], source: 'none', error: 'no known way to list this CLI\'s models' };
      continue;
    }
    try {
      if (src.kind === 'file') {
        const path = src.fromHome ? `${home}/${src.path}` : src.path;
        out[id] = { models: src.parse(readFile(path)), source: path };
      } else {
        if (!findBin(src.bin)) {
          out[id] = { models: [], source: `${src.bin} ${src.args.join(' ')}`, error: 'not installed' };
          continue;
        }
        out[id] = { models: src.parse(runCommand(src.bin, src.args)), source: `${src.bin} ${src.args.join(' ')}` };
      }
    } catch (err) {
      out[id] = {
        models: [],
        source: src.kind === 'file' ? String(src.path) : `${src.bin} ${src.args.join(' ')}`,
        error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
      };
    }
  }
  return out;
}
