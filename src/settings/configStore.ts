import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError, defaultConfig, parseConfig, type AppConfig } from '../config.js';
import { writeFileAtomic } from './atomic.js';
import { isKnownSetting, looksLikeSecret, restartRequiredFor } from './schema.js';

/**
 * `config.json`, editable from the browser without ever leaving it broken.
 *
 * Two rules do most of the work here. The candidate is validated with the same
 * `parseConfig` the CLI uses **before** anything is written, so a bad value
 * comes back as a message rather than a file nobody can start from. And the
 * patch is merged into the raw JSON rather than into the parsed config, so
 * saving one setting does not rewrite the file with every default spelled out.
 */

export interface UpdateResult {
  ok: boolean;
  config?: AppConfig;
  /** The ConfigError message, verbatim — they are written to be read. */
  error?: string;
  /** Written, but the process has to be restarted before they do anything. */
  restartRequired?: string[];
  mtimeMs?: number | undefined;
}

export class ConfigStore {
  readonly path: string;
  private parsed: AppConfig;
  private raw: Record<string, unknown> | undefined;
  private loadError: string | undefined;
  private missing = true;
  private mtime: number | undefined;

  constructor(path = 'config.json') {
    this.path = resolve(path);
    this.parsed = defaultConfig();
    this.load();
  }

  get current(): AppConfig {
    return this.parsed;
  }

  get error(): string | undefined {
    return this.loadError;
  }

  get usingDefaults(): boolean {
    return this.raw === undefined;
  }

  get isMissing(): boolean {
    return this.missing;
  }

  get mtimeMs(): number | undefined {
    return this.mtime;
  }

  load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
      this.mtime = statSync(this.path).mtimeMs;
      this.missing = false;
    } catch {
      // No file yet. The defaults are a working setup, so this is not an error
      // — the first save writes one.
      this.missing = true;
      this.raw = undefined;
      this.loadError = undefined;
      this.parsed = defaultConfig();
      return;
    }

    try {
      const raw = JSON.parse(text) as unknown;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ConfigError('config must be a JSON object');
      }
      this.parsed = parseConfig(raw);
      this.raw = raw as Record<string, unknown>;
      this.loadError = undefined;
    } catch (err) {
      // Keep serving on defaults so the page that reports this can load.
      this.raw = undefined;
      this.loadError = (err as Error).message;
      this.parsed = defaultConfig();
    }
  }

  /** Re-read if something else changed the file under us. */
  reloadIfChanged(): boolean {
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    if (mtimeMs === this.mtime) return false;
    this.load();
    return true;
  }

  async update(
    patch: Record<string, unknown>,
    options: { expectedMtimeMs?: number | undefined } = {},
  ): Promise<UpdateResult> {
    const paths = Object.keys(patch);

    for (const path of paths) {
      if (!isKnownSetting(path)) {
        return { ok: false, error: `unknown setting "${path}"` };
      }
      if (looksLikeSecret(patch[path])) {
        return {
          ok: false,
          error:
            `"${path}" looks like a credential. Those go in .env, which is not committed — ` +
            `config.json is.`,
        };
      }
    }

    if (this.loadError) {
      return {
        ok: false,
        error:
          `config.json cannot be read (${this.loadError}), so a change cannot be merged ` +
          `into it. Reset it to the defaults first.`,
      };
    }

    if (
      options.expectedMtimeMs !== undefined &&
      this.mtime !== undefined &&
      options.expectedMtimeMs !== this.mtime
    ) {
      return { ok: false, error: 'config.json changed on disk since this page loaded' };
    }

    const merged = structuredClone(this.raw ?? {});
    for (const [path, value] of Object.entries(patch)) setAt(merged, path, value);

    let validated: AppConfig;
    try {
      validated = parseConfig(merged);
    } catch (err) {
      // Nothing has touched the disk at this point, and nothing will.
      return { ok: false, error: (err as Error).message };
    }

    await writeFileAtomic(this.path, serialise(merged, this.readIndent()), { backup: true });

    this.raw = merged;
    this.parsed = validated;
    this.missing = false;
    try {
      this.mtime = statSync(this.path).mtimeMs;
    } catch {
      this.mtime = undefined;
    }

    const restartRequired = restartRequiredFor(paths);
    return {
      ok: true,
      config: validated,
      mtimeMs: this.mtime,
      ...(restartRequired.length > 0 ? { restartRequired } : {}),
    };
  }

  /** Back up whatever is there and write the built-in defaults. */
  async reset(): Promise<UpdateResult> {
    const defaults = defaultConfig();
    await writeFileAtomic(this.path, `${JSON.stringify(defaults, null, 2)}\n`, { backup: true });
    this.load();
    return { ok: true, config: this.parsed, mtimeMs: this.mtime };
  }

  /** Match whatever indentation the file already uses. */
  private readIndent(): number {
    try {
      const second = readFileSync(this.path, 'utf8').split('\n')[1] ?? '';
      const match = /^(\s+)/.exec(second);
      return match ? match[1]!.length : 2;
    } catch {
      return 2;
    }
  }
}

function setAt(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function serialise(value: unknown, indent: number): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}
