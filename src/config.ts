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
  /**
   * Restrict recognition to `sourceLanguages` rather than treating them as
   * hints. Soniox's own guidance is that results are best with a single
   * language named, and a working prototype of this job sets it — but this
   * bridge names two (gu and en) because sermons code-switch, so it is off by
   * default and worth testing against your own speaker.
   */
  languageHintsStrict: boolean;
  /**
   * Use the built-in Swaminarayan glossary and register instructions from
   * `soniox/vocabulary.ts`. The two lists above are added on top of it and win
   * on conflict. Off means local terms alone.
   */
  builtInGlossary: boolean;
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
  paths: { recordings: string };
  database: { urlEnv: string };
  server: {
    host: string;
    port: number;
    /**
     * Hand the URL token to any browser already on this network, so the
     * homepage can be reached by typing the short address alone. Turn it off
     * on a network you do not control; every link then needs its token typed.
     */
    shareTokenOnLan: boolean;
  };
  live: {
    /**
     * Our own cut. A caption cannot exist until the sentence it covers has
     * finished being spoken, so this is the biggest lever on how soon one
     * appears — and the cost of cutting sooner is splitting sentences.
     */
    maxBufferMs: number;
    /** -1 patient to 1 eager; how readily Soniox calls a clause finished. */
    endpointSensitivity: number;
    /** Ceiling on that wait, for a speaker who does not pause. */
    maxEndpointDelayMs: number;
    /** Names the variable holding YouTube's caption ingestion URL. The URL
     *  embeds a `cid` that identifies the stream, so it is a credential and
     *  lives in .env with the rest — never in this committed file. */
    youtubeCaptionsUrlEnv: string;
    /** Write an .srt into `paths.recordings` while a service runs. */
    liveSrt: boolean;
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
    builtInGlossary: true,
    languageHintsStrict: false,
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
  paths: { recordings: './recordings' },
  database: { urlEnv: 'DATABASE_URL' },
  server: { host: '0.0.0.0', port: 3000, shareTokenOnLan: true },
  live: {
    // Measured, not guessed: across all 594 cues of a real 69-minute sermon, the
    liveSrt: true,
    youtubeCaptionsUrlEnv: 'YOUTUBE_INGESTION_URL',
    maxBufferMs: 8000,
    /*
      From the American mandirs' bridge, and kept after trying to beat them.

      The probe was one sentence: the speaker says "આ દર્શન-શ્રવણ" (this
      seeing-and-hearing), which is the same phonemes as "આદર્શ" (ideal) with
      the word boundary moved. At -0.25 Soniox closes the clause mid-compound
      and commits to "ideal" — "and also the online ideal". The same audio
      transcribed offline, with the whole sentence available, gets it right.

        -0.25 / 2500  the wrong word, but prompt at about a second
        -0.50 / 3500  the right word, compounds intact, slowest line 11.0s
        -0.75 / 5000  the right word and much worse everywhere else: clauses
                      outran maxBufferMs so our own cut split "Pancham
                      Varasdar" across two captions, and the slowest line was
                      ready 17.1s after the speech ended — seventeen seconds
                      of a speaker talking with nothing under them

      -0.5 looked like the answer and is not shipped, because watching it run is
      the part a table does not capture: the captions felt sticky, and the
      sentence it was supposed to fix still lost the word "online" in
      translation even once the parse was right. A correct parse of a phrase
      whose key word is then dropped is not worth a second of lag on every line.

      Worth revisiting deliberately rather than by feel — both are settings, and
      the ceiling is delayAssemblyMs: a line that takes longer than the assembly
      delay to become ready is not a late caption, it is no caption.
    */
    endpointSensitivity: -0.25,
    maxEndpointDelayMs: 2500,
  },
} satisfies AppConfig;

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

/** A string from a fixed set — anything else is a typo worth naming. */
function oneOf<T extends string>(
  value: unknown,
  path: string,
  fallback: T,
  allowed: readonly T[],
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`${path} must be true or false`);
  return value;
}

/** Soniox's endpoint sensitivity runs -1 to 1, so `num` (non-negative) will not do. */
function signed(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${path} must be a number between ${min} and ${max}`);
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
      languageHintsStrict: bool(
        soniox['languageHintsStrict'],
        'soniox.languageHintsStrict',
        DEFAULTS.soniox.languageHintsStrict,
      ),
      builtInGlossary: bool(
        soniox['builtInGlossary'],
        'soniox.builtInGlossary',
        DEFAULTS.soniox.builtInGlossary,
      ),
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
      recordings: str(paths['recordings'], 'paths.recordings', DEFAULTS.paths.recordings),
    },
    database: {
      urlEnv: str(database['urlEnv'], 'database.urlEnv', DEFAULTS.database.urlEnv),
    },
    server: {
      host: str(server['host'], 'server.host', DEFAULTS.server.host),
      port: num(server['port'], 'server.port', DEFAULTS.server.port),
      shareTokenOnLan: bool(
        server['shareTokenOnLan'],
        'server.shareTokenOnLan',
        DEFAULTS.server.shareTokenOnLan,
      ),
    },
    live: {
      liveSrt: bool(live['liveSrt'], 'live.liveSrt', DEFAULTS.live.liveSrt),
      youtubeCaptionsUrlEnv: str(
        live['youtubeCaptionsUrlEnv'],
        'live.youtubeCaptionsUrlEnv',
        DEFAULTS.live.youtubeCaptionsUrlEnv,
      ),
      maxBufferMs: num(live['maxBufferMs'], 'live.maxBufferMs', DEFAULTS.live.maxBufferMs),
      endpointSensitivity: signed(
        live['endpointSensitivity'],
        'live.endpointSensitivity',
        DEFAULTS.live.endpointSensitivity,
        -1,
        1,
      ),
      maxEndpointDelayMs: num(
        live['maxEndpointDelayMs'],
        'live.maxEndpointDelayMs',
        DEFAULTS.live.maxEndpointDelayMs,
      ),
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
          // The same invocation the README and the preflight fix use — the bare
          // `sermon-captions` binary only exists once the package is linked.
          `Run \`npx tsx src/cli.ts publish --auth\` to mint a refresh token.`,
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
