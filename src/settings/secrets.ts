import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { maskSecret, writeSecrets } from './env.js';
import { SECRETS, type SecretDescriptor } from './schema.js';

/**
 * The credentials, as the browser is allowed to see them: which ones are set,
 * and the last four characters. Never the values.
 *
 * Writing one updates `.env` *and* this process. `resolveApiKey` reads
 * `process.env` at the moment it is called, so setting it here is what makes a
 * key pasted into the settings page work on the very next start with nothing
 * restarted — which is the whole reason the page is worth having.
 */

export interface SecretState {
  /** The env var, e.g. SONIOX_API_KEY. */
  name: string;
  label: string;
  help: string;
  group: SecretDescriptor['group'];
  set: boolean;
  /** `…a91f`, enough to tell two keys apart. */
  hint: string;
  /** Set in the shell rather than .env, so writing here would not win. */
  fromShell: boolean;
  optional: boolean;
}

export class SecretsService {
  readonly path: string;
  private readonly getConfig: () => AppConfig;
  private readonly listeners = new Set<(names: string[]) => void>();

  constructor(getConfig: () => AppConfig, path = '.env') {
    this.getConfig = getConfig;
    this.path = resolve(path);
  }

  onChange(listener: (names: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve a descriptor's `configPath` to the variable name it points at. */
  nameFor(descriptor: SecretDescriptor): string {
    const config = this.getConfig() as unknown as Record<string, unknown>;
    const parts = descriptor.configPath.split('.');
    let node: unknown = config;
    for (const part of parts) {
      if (typeof node !== 'object' || node === null) return descriptor.configPath;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : descriptor.configPath;
  }

  list(env: NodeJS.ProcessEnv = process.env): SecretState[] {
    const inFile = new Set(namesInEnvFile(this.path));
    return SECRETS.map((descriptor) => {
      const name = this.nameFor(descriptor);
      const value = env[name];
      const set = typeof value === 'string' && value.trim() !== '';
      return {
        name,
        label: descriptor.label,
        help: descriptor.help,
        group: descriptor.group,
        set,
        hint: set ? maskSecret(value) : '',
        // Worth surfacing: a shell export beats the file, so saving here would
        // look like it had no effect.
        fromShell: set && !inFile.has(name),
        optional: descriptor.optional ?? false,
      };
    });
  }

  /** Look up one secret's current value, for code that needs it now. */
  get(configPath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const descriptor = SECRETS.find((entry) => entry.configPath === configPath);
    if (!descriptor) return undefined;
    const value = env[this.nameFor(descriptor)];
    return value && value.trim() !== '' ? value.trim() : undefined;
  }

  async set(updates: Record<string, string | null>): Promise<void> {
    const known = new Set(SECRETS.map((descriptor) => this.nameFor(descriptor)));
    for (const name of Object.keys(updates)) {
      if (!known.has(name)) throw new Error(`"${name}" is not a credential this bridge uses`);
    }

    // Disk first. A process holding a working key that was never written is
    // worse than a failed save: it keeps working until the next restart and
    // then breaks with no obvious cause.
    await writeSecrets(this.path, updates);

    for (const [name, value] of Object.entries(updates)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }

    const names = Object.keys(updates);
    for (const listener of this.listeners) listener(names);
  }
}

function namesInEnvFile(path: string): string[] {
  try {
    const text = readFileSync(path, 'utf8');
    const names: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match) names.push(match[1]!);
    }
    return names;
  } catch {
    return [];
  }
}
