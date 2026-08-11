/**
 * cli-models-cache.mjs — read the model list scan-cli-models.mjs wrote.
 *
 * Separate from cli-models.mjs (which does the discovering) so the request
 * path only ever reads a small JSON file. Discovery shells out to CLIs and
 * takes seconds; a settings page must not.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CLI_MODELS_CACHE = path.join('.career-ops-web', 'cli-models.json');

/**
 * @param {string} [root] - career-ops root; defaults to cwd.
 * @returns {object|null} Parsed cache, or null when absent/corrupt. Never
 *   throws: no cache is the normal state before the first scan, and a
 *   half-written file must not take the Config page down with it.
 */
export function readModelCache(root = process.cwd()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, CLI_MODELS_CACHE), 'utf8'));
  } catch {
    return null;
  }
}
