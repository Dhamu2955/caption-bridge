import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from './atomic.js';

/**
 * Editing `.env` without destroying it.
 *
 * `.env` is written by hand from `.env.example`, which is mostly comments —
 * why the key belongs there rather than in `config.json`, the seven-day
 * refresh-token trap, which console to mint each credential at. Regenerating
 * the file from a key/value map would throw all of that away the first time
 * someone saved a setting from the browser.
 *
 * So this rewrites in place: an existing key keeps its line number, and the
 * comment sitting above it stays attached to it. Everything else is left byte
 * for byte as it was found.
 */

const KEY_LINE = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export class EnvWriteError extends Error {}

/** Values that would need escaping to survive a round trip get quoted. */
function needsQuoting(value: string): boolean {
  return value === '' || value !== value.trim() || /[\s#"'`$\\]/.test(value);
}

function encode(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Apply `updates` to the text of a `.env` file.
 *
 * A `null` value removes the key. Pure, so the risky part — the part that could
 * corrupt someone's credentials — is testable without touching a disk.
 */
export function upsertEnv(text: string, updates: Record<string, string | null>): string {
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) continue;
    if (/[\r\n]/.test(value)) {
      // Nearly always a paste that picked up a trailing line, and multi-line
      // values are a trap in every dotenv dialect. Refuse rather than write
      // something that silently truncates on the next load.
      throw new EnvWriteError(`${name}: the value contains a line break`);
    }
  }

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));

  const kept: string[] = [];
  for (const line of lines) {
    const match = KEY_LINE.exec(line);
    const name = match?.[2];
    if (name === undefined || !remaining.has(name)) {
      kept.push(line);
      continue;
    }

    const value = remaining.get(name)!;
    remaining.delete(name);
    // Removing a key drops its line but leaves the comment above it, which is
    // the honest outcome: the explanation is still true, the value is just gone.
    if (value === null) continue;
    kept.push(`${match?.[1] ?? ''}${name}=${encode(value)}`);
  }

  // Anything not already present is appended, so a freshly configured key lands
  // at the end rather than in the middle of somebody else's section.
  const added: string[] = [];
  for (const [name, value] of remaining) {
    if (value === null) continue;
    added.push(`${name}=${encode(value)}`);
  }

  if (added.length > 0) {
    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
    if (kept.length > 0) kept.push('');
    kept.push(...added);
    kept.push('');
  }

  return kept.join(newline);
}

/** Every variable named in the file, in the order it appears. */
export function readEnvNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = KEY_LINE.exec(line)?.[2];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * `sk-…a91f`. Enough to tell two keys apart when confirming which one is
 * loaded, not enough to be worth intercepting.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length <= 4) return '…';
  return `…${trimmed.slice(-4)}`;
}

/**
 * Write secrets to `.env`, creating it if this is the first one.
 *
 * Disk first, then `process.env` at the call site: a process holding a working
 * key that was never persisted is worse than a failed write, because it keeps
 * working until the next restart and then breaks with no obvious cause.
 */
export async function writeSecrets(
  path: string,
  updates: Record<string, string | null>,
): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    /* first secret — start from an empty file */
  }

  const next = upsertEnv(existing, updates);
  if (next === existing) return;

  // 0600: this file holds every credential the bridge has.
  await writeFileAtomic(path, next, { mode: 0o600, backup: true });
}
