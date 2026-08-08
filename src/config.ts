import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Config per SPEC §5. Committed to the repo — no credentials here, ever.
 * The API key is named by `soniox.apiKeyEnv` and read from the environment.
 */

export interface TranslationTerm {
  source: string;
  target: string;
}

export interface SonioxConfig {
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
  sourceLanguages: string[];
  targetLanguage: string;
  /** Proper nouns, deity names, scriptural terms — improves recognition. */
  contextTerms: string[];
  /** Source→target pairs so the same term translates consistently every week. */
  translationTerms: TranslationTerm[];
}

export interface IngestConfig {
  /** Silence between blocks that ends a segment. Async has no endpoint
   *  detection, so this is what stands in for it. See §4 phase 1. */
  pauseMs: number;
  /** Soft cap on translated characters per cue (§4: "~120"). */
  maxChars: number;
  /** Hard cap on cue duration, so a stretch without punctuation or pauses
   *  cannot produce a 40-second caption. */
  maxSegmentMs: number;
  /** INVARIANT 4. No cue shorter than this — merge instead. */
  minDisplayMs: number;
  /** Soft wrap width. */
  maxLineChars: number;
  /** Lines per cue. §4 says two — raise deliberately, it changes the look. */
  maxLines: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export interface YoutubeConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
  refreshTokenEnv: string;
  /** The API's default daily allowance. Bulk publish paces itself against it. */
  dailyQuotaUnits: number;
  /** Port for the one-off `publish --auth` loopback redirect. */
  authPort: number;
}

export interface SearchConfig {
  /** Multilingual so a Gujarati query can reach English text (§3). Changing
   *  this invalidates every stored vector — re-index after. */
  model: string;
  dimensions: number;
  /** §3: chunk above segment level, 1–3 minute passages with overlap. */
  chunkTargetMs: number;
  chunkMaxMs: number;
  chunkOverlapMs: number;
}

export interface AppConfig {
  soniox: SonioxConfig;
  ingest: IngestConfig;
  youtube: YoutubeConfig;
  search: SearchConfig;
  paths: { media: string; recordings: string };
  database: { urlEnv: string };
  server: { host: string; port: number };
  live: {
    delayAssemblyMs: number;
    delayReviewMs: number;
    minDisplayMs: number;
    lateSkipMs: number;
    /** Names the variable holding YouTube's caption ingestion URL. The URL
     *  embeds a `cid` that identifies the stream, so it is a credential and
     *  lives in .env with the rest — never in this committed file. */
    youtubeCaptionsUrlEnv: string;
    /** Delay between this machine's encoder and YouTube receiving the video. */
    streamOffsetMs: number;
  };
}

const DEFAULTS = {
  soniox: {
    apiKeyEnv: 'SONIOX_API_KEY',
    baseUrl: 'https://api.soniox.com/v1',
    model: 'stt-async-v5',
    sourceLanguages: ['gu', 'en'],
    targetLanguage: 'en',
    contextTerms: [] as string[],
    translationTerms: [] as TranslationTerm[],
  },
  ingest: {
    pauseMs: 1200,
    maxChars: 120,
    maxSegmentMs: 7000,
    minDisplayMs: 1500,
    maxLineChars: 42,
    maxLines: 2,
    pollIntervalMs: 3000,
    pollTimeoutMs: 3_600_000,
  },
  youtube: {
    clientIdEnv: 'YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
    refreshTokenEnv: 'YOUTUBE_REFRESH_TOKEN',
    dailyQuotaUnits: 10_000,
    authPort: 8719,
  },
  search: {
    model: 'Xenova/multilingual-e5-small',
    dimensions: 384,
    chunkTargetMs: 120_000,
    chunkMaxMs: 180_000,
    chunkOverlapMs: 30_000,
  },
  paths: { media: './media', recordings: './recordings' },
  database: { urlEnv: 'DATABASE_URL' },
  server: { host: '127.0.0.1', port: 3000 },
  live: {
    delayAssemblyMs: 4000,
    // Three minutes, not the 25 seconds phase 5 was designed around. At 25s a
    // reviewer can realistically only drop a line; correcting one needs time to
    // read the Gujarati, judge the English, and type. Tunable up to 10 minutes
    // — but a delay this long cannot live in vMix's Video Delay, which is
    // RAM-resident. See docs/vmix-routing.md.
    delayReviewMs: 180_000,
    minDisplayMs: 1500,
    lateSkipMs: 2000,
    youtubeCaptionsUrlEnv: 'YOUTUBE_INGESTION_URL',
    streamOffsetMs: 0,
  },
} satisfies AppConfig;

/** Ten minutes. Past this the stream is so far behind the room that the two
 *  stop being the same event; it is also a lot of buffered video. */
const MAX_REVIEW_MS = 600_000;

export class ConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function num(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${path} must be a non-negative number`);
  }
  return value;
}

function strArray(value: unknown, path: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`${path} must be an array of strings`);
  }
  return value as string[];
}

/**
 * §5 writes `translationTerms` as a bare list, but the Soniox `context` object
 * wants {source, target} pairs. Accept either — a bare string maps to itself,
 * which is the "transliterate this name, don't translate it" case.
 */
function translationTerms(value: unknown, path: string): TranslationTerm[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path} must be an array`);
  }
  return value.map((entry, i) => {
    if (typeof entry === 'string') return { source: entry, target: entry };
    if (isRecord(entry) && typeof entry['source'] === 'string' && typeof entry['target'] === 'string') {
      return { source: entry['source'], target: entry['target'] };
    }
    throw new ConfigError(`${path}[${i}] must be a string or {source, target}`);
  });
}

export function parseConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) throw new ConfigError('config must be a JSON object');

  const soniox = isRecord(raw['soniox']) ? raw['soniox'] : {};
  const ingest = isRecord(raw['ingest']) ? raw['ingest'] : {};
  const youtube = isRecord(raw['youtube']) ? raw['youtube'] : {};
  const searchRaw = isRecord(raw['search']) ? raw['search'] : {};
  const paths = isRecord(raw['paths']) ? raw['paths'] : {};
  const database = isRecord(raw['database']) ? raw['database'] : {};
  const server = isRecord(raw['server']) ? raw['server'] : {};
  const live = isRecord(raw['live']) ? raw['live'] : {};

  const config: AppConfig = {
    soniox: {
      apiKeyEnv: str(soniox['apiKeyEnv'], 'soniox.apiKeyEnv', DEFAULTS.soniox.apiKeyEnv),
      baseUrl: str(soniox['baseUrl'], 'soniox.baseUrl', DEFAULTS.soniox.baseUrl).replace(/\/+$/, ''),
      model: str(soniox['model'], 'soniox.model', DEFAULTS.soniox.model),
      sourceLanguages: strArray(soniox['sourceLanguages'], 'soniox.sourceLanguages', DEFAULTS.soniox.sourceLanguages),
      targetLanguage: str(soniox['targetLanguage'], 'soniox.targetLanguage', DEFAULTS.soniox.targetLanguage),
      contextTerms: strArray(soniox['contextTerms'], 'soniox.contextTerms', DEFAULTS.soniox.contextTerms),
      translationTerms: translationTerms(soniox['translationTerms'], 'soniox.translationTerms'),
    },
    ingest: {
      pauseMs: num(ingest['pauseMs'], 'ingest.pauseMs', DEFAULTS.ingest.pauseMs),
      maxChars: num(ingest['maxChars'], 'ingest.maxChars', DEFAULTS.ingest.maxChars),
      maxSegmentMs: num(ingest['maxSegmentMs'], 'ingest.maxSegmentMs', DEFAULTS.ingest.maxSegmentMs),
      minDisplayMs: num(ingest['minDisplayMs'], 'ingest.minDisplayMs', DEFAULTS.ingest.minDisplayMs),
      maxLineChars: num(ingest['maxLineChars'], 'ingest.maxLineChars', DEFAULTS.ingest.maxLineChars),
      maxLines: num(ingest['maxLines'], 'ingest.maxLines', DEFAULTS.ingest.maxLines),
      pollIntervalMs: num(ingest['pollIntervalMs'], 'ingest.pollIntervalMs', DEFAULTS.ingest.pollIntervalMs),
      pollTimeoutMs: num(ingest['pollTimeoutMs'], 'ingest.pollTimeoutMs', DEFAULTS.ingest.pollTimeoutMs),
    },
    youtube: {
      clientIdEnv: str(youtube['clientIdEnv'], 'youtube.clientIdEnv', DEFAULTS.youtube.clientIdEnv),
      clientSecretEnv: str(youtube['clientSecretEnv'], 'youtube.clientSecretEnv', DEFAULTS.youtube.clientSecretEnv),
      refreshTokenEnv: str(youtube['refreshTokenEnv'], 'youtube.refreshTokenEnv', DEFAULTS.youtube.refreshTokenEnv),
      dailyQuotaUnits: num(youtube['dailyQuotaUnits'], 'youtube.dailyQuotaUnits', DEFAULTS.youtube.dailyQuotaUnits),
      authPort: num(youtube['authPort'], 'youtube.authPort', DEFAULTS.youtube.authPort),
    },
    search: {
      model: str(searchRaw['model'], 'search.model', DEFAULTS.search.model),
      dimensions: num(searchRaw['dimensions'], 'search.dimensions', DEFAULTS.search.dimensions),
      chunkTargetMs: num(searchRaw['chunkTargetMs'], 'search.chunkTargetMs', DEFAULTS.search.chunkTargetMs),
      chunkMaxMs: num(searchRaw['chunkMaxMs'], 'search.chunkMaxMs', DEFAULTS.search.chunkMaxMs),
      chunkOverlapMs: num(searchRaw['chunkOverlapMs'], 'search.chunkOverlapMs', DEFAULTS.search.chunkOverlapMs),
    },
    paths: {
      media: str(paths['media'], 'paths.media', DEFAULTS.paths.media),
      recordings: str(paths['recordings'], 'paths.recordings', DEFAULTS.paths.recordings),
    },
    database: {
      urlEnv: str(database['urlEnv'], 'database.urlEnv', DEFAULTS.database.urlEnv),
    },
    server: {
      host: str(server['host'], 'server.host', DEFAULTS.server.host),
      port: num(server['port'], 'server.port', DEFAULTS.server.port),
    },
    live: {
      delayAssemblyMs: num(live['delayAssemblyMs'], 'live.delayAssemblyMs', DEFAULTS.live.delayAssemblyMs),
      delayReviewMs: num(live['delayReviewMs'], 'live.delayReviewMs', DEFAULTS.live.delayReviewMs),
      minDisplayMs: num(live['minDisplayMs'], 'live.minDisplayMs', DEFAULTS.live.minDisplayMs),
      lateSkipMs: num(live['lateSkipMs'], 'live.lateSkipMs', DEFAULTS.live.lateSkipMs),
      youtubeCaptionsUrlEnv: str(
        live['youtubeCaptionsUrlEnv'],
        'live.youtubeCaptionsUrlEnv',
        DEFAULTS.live.youtubeCaptionsUrlEnv,
      ),
      streamOffsetMs: num(live['streamOffsetMs'], 'live.streamOffsetMs', DEFAULTS.live.streamOffsetMs),
    },
  };

  if (config.ingest.maxSegmentMs < config.ingest.minDisplayMs) {
    throw new ConfigError('ingest.maxSegmentMs must be >= ingest.minDisplayMs');
  }
  if (config.search.chunkMaxMs < config.search.chunkTargetMs) {
    throw new ConfigError('search.chunkMaxMs must be >= search.chunkTargetMs');
  }
  if (config.soniox.sourceLanguages.length === 0) {
    throw new ConfigError('soniox.sourceLanguages must list at least one language');
  }
  if (config.live.delayReviewMs > MAX_REVIEW_MS) {
    throw new ConfigError(
      `live.delayReviewMs must be at most ${MAX_REVIEW_MS} (10 minutes) — a longer delay ` +
        `puts the stream far enough behind the room to stop being the same event`,
    );
  }

  return config;
}

/** The built-in configuration, for a machine that has no `config.json` yet. */
export function defaultConfig(): AppConfig {
  return parseConfig({});
}

export interface LoadedConfig {
  config: AppConfig;
  /** Why the file was not used, if it was not. */
  error: string | undefined;
  /** False when `config` is the built-in defaults rather than the file. */
  fromFile: boolean;
  /** No file at all — normal on a fresh machine, and not a problem. */
  missing: boolean;
  path: string;
  mtimeMs: number | undefined;
}

/**
 * Load `config.json` but never fail on it.
 *
 * The CLI is right to refuse to run against a broken config — a transcription
 * run costs money and should not proceed on assumptions. The server is not:
 * it has to come up and *show* the operator what is wrong, which it cannot do
 * if a stray comma stops it from starting. So a missing or malformed file
 * yields the defaults plus an error to display.
 */
export function loadConfigSafe(path = 'config.json'): LoadedConfig {
  const full = resolve(path);
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(full).mtimeMs;
  } catch {
    /* no file — reported below */
  }

  const missing = mtimeMs === undefined;

  try {
    return {
      config: loadConfig(path),
      error: undefined,
      fromFile: true,
      missing: false,
      path: full,
      mtimeMs,
    };
  } catch (err) {
    return {
      config: defaultConfig(),
      // An absent file is not an error — the defaults are a working setup and
      // writing one is what the settings page does. A file that exists but
      // cannot be parsed is a different matter, and keeps its message.
      error: missing ? undefined : (err as Error).message,
      fromFile: false,
      missing,
      path: full,
      mtimeMs,
    };
  }
}

export function loadConfig(path = 'config.json'): AppConfig {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new ConfigError(`cannot read config file: ${full}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${full} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

export interface YoutubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * OAuth credentials for `publish`. Same rule as the Soniox key: config.json
 * names the variables, `.env` holds the values, and `.env` is gitignored.
 *
 * `refreshToken` is optional here because `publish --auth` exists precisely to
 * mint one — it needs the client pair and nothing else.
 */
export function resolveYoutubeCredentials(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { requireRefreshToken?: boolean } = {},
): YoutubeCredentials {
  const read = (name: string): string => {
    const value = env[name];
    if (!value || value.trim() === '') {
      throw new ConfigError(
        `${name} is not set. Put it in .env — never in config.json. ` +
          `Run \`sermon-captions publish --auth\` to mint a refresh token.`,
      );
    }
    return value.trim();
  };

  const refreshTokenRaw = env[config.youtube.refreshTokenEnv];
  return {
    clientId: read(config.youtube.clientIdEnv),
    clientSecret: read(config.youtube.clientSecretEnv),
    refreshToken:
      options.requireRefreshToken === false
        ? (refreshTokenRaw ?? '').trim()
        : read(config.youtube.refreshTokenEnv),
  };
}

export function resolveApiKey(config: AppConfig, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[config.soniox.apiKeyEnv];
  if (!key || key.trim() === '') {
    throw new ConfigError(
      `${config.soniox.apiKeyEnv} is not set. Export it or put it in .env — never in config.json.`,
    );
  }
  return key.trim();
}
