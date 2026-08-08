import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AppConfig } from '../config.js';
import { resolveApiKey, resolveYoutubeCredentials } from '../config.js';
import { resolveDatabaseUrl } from '../db/client.js';
import type { PrismaProvider } from '../db/provider.js';
import { listAudioDevices } from './devices.js';
import type { CaptureFormat } from './capture.js';

/**
 * "Is this machine ready, and if not, what is the one thing to do next?"
 *
 * The server has to start before any of this is true — a fresh clone with no
 * `.env`, no database and possibly no ffmpeg still has to serve a page that
 * explains itself. So nothing here throws; every failure becomes a `Check` the
 * UI can render, with a `fix` written for whoever runs the switcher on a
 * Sunday rather than for a developer.
 */

export type CheckId =
  | 'config'
  | 'apiKey'
  | 'ffmpeg'
  | 'devices'
  | 'database'
  | 'dbSchema'
  | 'youtube';

export type CheckState = 'ok' | 'missing' | 'error' | 'unknown';

/** What a check standing in the way actually prevents. */
export type Capability = 'live' | 'ingest' | 'archive' | 'publish' | 'search';

export interface Check {
  id: CheckId;
  label: string;
  state: CheckState;
  detail?: string;
  /** One action, in plain language. */
  fix?: string;
  blocks: Capability[];
  checkedAt: number;
}

export interface CapabilityStatus {
  ready: boolean;
  blockedBy: CheckId[];
}

const execFileAsync = promisify(execFile);

export interface PreflightOptions {
  getConfig: () => AppConfig;
  /** The config file's parse error, if it had one. */
  getConfigError?: () => string | undefined;
  database: PrismaProvider;
  format?: CaptureFormat | undefined;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so nothing spawns ffmpeg. */
  probeFfmpeg?: () => Promise<{ ok: boolean; version?: string; missing?: boolean }>;
  listDevices?: () => Promise<{ name: string }[]>;
}

/** How long each answer is trusted before it is worth asking again. */
const TTL: Record<CheckId, number> = {
  config: 0,
  apiKey: 0,
  youtube: 0,
  ffmpeg: 60_000,
  devices: 5_000,
  database: 10_000,
  dbSchema: 30_000,
};

export class PreflightChecks {
  private readonly options: PreflightOptions;
  private readonly cache = new Map<CheckId, Check>();

  constructor(options: PreflightOptions) {
    this.options = options;
  }

  /** Force the slow probes to be re-run — the "I just installed it" button. */
  refresh(): void {
    this.cache.clear();
  }

  async all(): Promise<Check[]> {
    const config = this.options.getConfig();
    const env = this.options.env ?? process.env;

    const checks: Check[] = [
      this.configCheck(),
      this.apiKeyCheck(config, env),
      await this.cached('ffmpeg', () => this.ffmpegCheck()),
      await this.cached('database', () => this.databaseCheck(config, env)),
      this.youtubeCheck(config, env),
    ];

    // Devices depend on ffmpeg. Reporting "no sound inputs found" when the real
    // problem is a missing binary sends people looking in the wrong place.
    const ffmpeg = checks.find((check) => check.id === 'ffmpeg')!;
    checks.splice(3, 0, await this.cached('devices', () => this.devicesCheck(ffmpeg)));

    // Likewise the schema is unknowable until the connection works.
    const database = checks.find((check) => check.id === 'database')!;
    if (database.state === 'ok') {
      checks.push(await this.cached('dbSchema', () => this.schemaCheck()));
    }

    return checks;
  }

  private async cached(id: CheckId, probe: () => Promise<Check>): Promise<Check> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.checkedAt < TTL[id]) return hit;
    const check = await probe();
    this.cache.set(id, check);
    return check;
  }

  private configCheck(): Check {
    const error = this.options.getConfigError?.();
    return {
      id: 'config',
      label: 'Settings file',
      state: error ? 'error' : 'ok',
      ...(error
        ? { detail: error, fix: 'Fix config.json, or reset it to the defaults' }
        : {}),
      // Everything still runs on the built-in defaults, so a bad settings file
      // is worth reporting but does not stop anything working.
      blocks: [],
      checkedAt: Date.now(),
    };
  }

  private apiKeyCheck(config: AppConfig, env: NodeJS.ProcessEnv): Check {
    try {
      resolveApiKey(config, env);
      return { id: 'apiKey', label: 'Soniox API key', state: 'ok', blocks: [], checkedAt: Date.now() };
    } catch (err) {
      return {
        id: 'apiKey',
        label: 'Soniox API key',
        state: 'missing',
        detail: (err as Error).message,
        fix: 'Paste your key on the Settings tab',
        blocks: ['live', 'ingest'],
        checkedAt: Date.now(),
      };
    }
  }

  private async ffmpegCheck(): Promise<Check> {
    const probe =
      this.options.probeFfmpeg ??
      (async () => {
        try {
          const { stdout } = await execFileAsync('ffmpeg', ['-version']);
          return { ok: true, version: stdout.split('\n')[0] };
        } catch (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          return { ok: false, missing, version: undefined };
        }
      });

    const result = await probe();
    if (result.ok) {
      return {
        id: 'ffmpeg',
        label: 'ffmpeg',
        state: 'ok',
        ...(result.version ? { detail: result.version } : {}),
        blocks: [],
        checkedAt: Date.now(),
      };
    }
    return {
      id: 'ffmpeg',
      label: 'ffmpeg',
      state: result.missing ? 'missing' : 'error',
      detail: result.missing ? 'not found on PATH' : 'could not be run',
      fix: 'Install ffmpeg (on macOS: brew install ffmpeg), then restart the bridge',
      blocks: ['live', 'ingest'],
      checkedAt: Date.now(),
    };
  }

  private async devicesCheck(ffmpeg: Check): Promise<Check> {
    if (ffmpeg.state !== 'ok') {
      return {
        id: 'devices',
        label: 'Sound inputs',
        state: 'unknown',
        detail: 'cannot be listed until ffmpeg is installed',
        blocks: [],
        checkedAt: Date.now(),
      };
    }

    try {
      const list = this.options.listDevices ?? (() => listAudioDevices(this.options.format));
      const devices = await list();
      return {
        id: 'devices',
        label: 'Sound inputs',
        state: devices.length > 0 ? 'ok' : 'missing',
        detail: devices.length > 0 ? `${devices.length} found` : 'none found',
        ...(devices.length === 0
          ? { fix: 'Check the audio cable or virtual device is installed' }
          : {}),
        blocks: devices.length > 0 ? [] : ['live'],
        checkedAt: Date.now(),
      };
    } catch (err) {
      return {
        id: 'devices',
        label: 'Sound inputs',
        state: 'error',
        detail: (err as Error).message,
        blocks: ['live'],
        checkedAt: Date.now(),
      };
    }
  }

  private async databaseCheck(config: AppConfig, env: NodeJS.ProcessEnv): Promise<Check> {
    const blocks: Capability[] = ['ingest', 'archive', 'publish', 'search'];
    try {
      resolveDatabaseUrl(config.database.urlEnv, env);
    } catch (err) {
      return {
        id: 'database',
        label: 'Database',
        state: 'missing',
        detail: (err as Error).message,
        fix: 'Run `docker compose up -d`, then paste the URL on the Settings tab',
        blocks,
        checkedAt: Date.now(),
      };
    }

    const probe = await this.options.database.probe();
    if (probe.ok) {
      return { id: 'database', label: 'Database', state: 'ok', blocks: [], checkedAt: Date.now() };
    }
    return {
      id: 'database',
      label: 'Database',
      state: 'error',
      ...(probe.error ? { detail: probe.error } : {}),
      fix: 'Start Postgres with `docker compose up -d`',
      blocks,
      checkedAt: Date.now(),
    };
  }

  private async schemaCheck(): Promise<Check> {
    const probe = await this.options.database.probe();
    if (probe.schema === 'ready') {
      return { id: 'dbSchema', label: 'Tables', state: 'ok', blocks: [], checkedAt: Date.now() };
    }
    return {
      id: 'dbSchema',
      label: 'Tables',
      state: probe.schema === 'missing' ? 'missing' : 'unknown',
      ...(probe.error ? { detail: probe.error } : {}),
      fix: 'Run `npx prisma migrate deploy`',
      blocks: ['ingest', 'archive', 'publish', 'search'],
      checkedAt: Date.now(),
    };
  }

  private youtubeCheck(config: AppConfig, env: NodeJS.ProcessEnv): Check {
    try {
      // Presence only — this must never make a network call.
      const credentials = resolveYoutubeCredentials(config, env, { requireRefreshToken: false });
      if (!credentials.refreshToken) {
        return {
          id: 'youtube',
          label: 'YouTube',
          state: 'missing',
          detail: 'signed up but not yet authorised',
          fix: 'Run `npx tsx src/cli.ts publish --auth` to mint a refresh token',
          blocks: ['publish'],
          checkedAt: Date.now(),
        };
      }
      return { id: 'youtube', label: 'YouTube', state: 'ok', blocks: [], checkedAt: Date.now() };
    } catch (err) {
      return {
        id: 'youtube',
        label: 'YouTube',
        state: 'missing',
        detail: (err as Error).message,
        fix: 'Only needed to put captions on your own channel — add the OAuth pair on Settings',
        blocks: ['publish'],
        checkedAt: Date.now(),
      };
    }
  }
}

const ALL_CAPABILITIES: Capability[] = ['live', 'ingest', 'archive', 'publish', 'search'];

/** Invert `blocks` so a page can say what it cannot do yet, and why. */
export function capabilitiesFrom(checks: Check[]): Record<Capability, CapabilityStatus> {
  const result = {} as Record<Capability, CapabilityStatus>;
  for (const capability of ALL_CAPABILITIES) {
    const blockedBy = checks
      .filter((check) => check.blocks.includes(capability))
      .map((check) => check.id);
    result[capability] = { ready: blockedBy.length === 0, blockedBy };
  }
  return result;
}
