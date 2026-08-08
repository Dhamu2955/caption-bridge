#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { ConfigError, loadConfig, resolveYoutubeCredentials, type AppConfig } from './config.js';
import { DatabaseError, resolveDatabaseUrl, withPrisma } from './db/client.js';
import { EditsWouldBeLostError } from './db/services.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { ingest } from './commands/ingest.js';
import { exportSrt } from './commands/export.js';
import { createYoutubeClient, publish, publishAll } from './commands/publish.js';
import { authorise } from './youtube/auth.js';
import { editTranslation, listAllServices, showSegments } from './commands/edit.js';
import { backfill } from './commands/backfill.js';
import { formatHit, runIndex, runSearch } from './commands/search.js';
import { runLive } from './commands/live.js';
import { runPlay } from './commands/play.js';
import type { CaptureFormat } from './live/capture.js';
import { listDevicesCommand } from './live/capture.js';
import { fail, info, warn } from './util/log.js';

const USAGE = `sermon-captions — Gujarati→English sermon subtitles

Usage:
  sermon-captions ingest <video> --speaker <name> --date <YYYY-MM-DD> [options]
  sermon-captions export <video|service-id> [--out-dir <dir>]
  sermon-captions publish <video|service-id> [--youtube-id <id>] [--dry-run]
  sermon-captions publish --all [--budget <units>]
  sermon-captions publish --auth
  sermon-captions edit   <video|service-id> --cue <n> --text "corrected text"
  sermon-captions show   <video|service-id> [--from <n>] [--limit <n>]
  sermon-captions list
  sermon-captions backfill <dir> --speaker <name> [--limit n] [--only <substr>]
  sermon-captions index  [<video|service-id>]
  sermon-captions search "<query>" [--limit n]
  sermon-captions play   <video|service-id> --input <vmix-guid> [--lines both]
  sermon-captions live   --device "<audio device>" [--outputs venue,stream]
  sermon-captions devices

ingest options:
  --speaker <name>    Who is speaking. Required.
  --date <date>       Service date, YYYY-MM-DD. Required.
  --title <text>      Optional service title.
  --force             Re-transcribe even if a cached transcript exists.
  --no-db             Write files only; do not touch the database.
  --replace-edited    Overwrite segments even if they carry human corrections.

publish options:
  --youtube-id <id>   The video on YOUR channel. Needed once; then remembered.
  --all               Publish every service that has a video id, paced to quota.
  --budget <units>    Quota units to spend in one run (default 90% of the day's).
  --dry-run           Show what would be uploaded; make no API calls.
  --force             Upload again even if nothing changed.
  --auth              Mint a refresh token, once, in a browser.

Captions can only be attached to videos on your own channel — sermons ripped
from other mandirs' streams cannot be published, only played back locally.

Common:
  --config <path>     Config file (default: config.json).
  -h, --help          Show this help.

Subtitles are generated artifacts — correct them with \`edit\`, then re-run
\`export\`. Never hand-edit an SRT; the next export overwrites it.

play options:
  --input <guid>      GUID of the vMix input playing the file. Never a number.
  --caption-input <guid>  Drive a GT title instead of the browser overlay.
  --vmix-url <url>    vMix web controller (default http://127.0.0.1:8088).
  --lines both        Gujarati above English on the overlay.

live options:
  --device <name>     Audio device carrying the SPEAKER'S MIC ONLY, not Master.
  --format <fmt>      dshow (Windows) | avfoundation (macOS). Auto-detected.
  --outputs <list>    Comma-separated: venue,stream,reviewer,overflow.
  --record <path>     Write every raw response and operator action to JSONL.
  --token <secret>    Overlay/reviewer URL token. Generated if omitted.
  --youtube-captions <url>  YouTube live caption ingestion URL.
  --stream-offset <ms>      Delay between your encoder and YouTube receiving it.
  --caption-input <guid>    Also drive a vMix GT title.
  --verbose           Log every release.

backfill options:
  --limit <n>         Stop after n files. Use it to trial the worst recordings.
  --only <substr>     Only files whose name contains this.
  --retry-failed      Retry files that failed on a previous run.
  --redo              Re-ingest files already in the database.
  --date <date>       Fallback when a filename carries no YYYY-MM-DD.

Needs SONIOX_API_KEY to ingest, and DATABASE_URL for everything else.
\`index\` downloads a local embedding model on first use; nothing leaves the machine.
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set([
  'all',
  'auth',
  'dry-run',
  'force',
  'help',
  'no-db',
  'replace-edited',
  'retry-failed',
  'redo',
  'verbose',
]);

export function parseArgv(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--') && arg !== '-h') {
      positional.push(arg);
      continue;
    }
    const name = arg === '-h' ? 'help' : arg.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('--')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }

  return { command: positional[0], positional: positional.slice(1), flags };
}

function requireString(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function optionalString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalNumber(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = optionalString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return value;
}

/**
 * Load .env if present. Anything already exported in the shell wins, so a
 * one-off `SONIOX_API_KEY=... npx tsx …` still overrides the file.
 */
function loadDotEnv(path = '.env'): void {
  const full = resolve(path);
  if (!existsSync(full)) return;
  try {
    process.loadEnvFile(full);
  } catch (err) {
    warn(`could not read ${full}: ${(err as Error).message}`);
  }
}

function withDb<T>(config: AppConfig, fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  return withPrisma(resolveDatabaseUrl(config.database.urlEnv), fn);
}

function firstPositional(positional: string[], what: string): string {
  const value = positional[0];
  if (!value) throw new Error(`a ${what} is required`);
  return value;
}

async function runIngest(positional: string[], flags: ParsedArgs['flags'], config: AppConfig) {
  const videoPath = firstPositional(positional, 'video file');
  const speaker = requireString(flags, 'speaker');
  const date = requireString(flags, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  }

  const args = {
    videoPath,
    speaker,
    date,
    title: optionalString(flags, 'title'),
    force: flags.get('force') === true,
    replaceEdited: flags.get('replace-edited') === true,
  };

  const result =
    flags.get('no-db') === true
      ? await ingest(args, config)
      : await withDb(config, (prisma) => ingest(args, config, prisma));

  const shortest = result.segments.reduce(
    (min, segment) => Math.min(min, segment.endMs - segment.startMs),
    Number.POSITIVE_INFINITY,
  );

  info('');
  info(`${result.segments.length} cues${result.cached ? ' (from cached transcript)' : ''}`);
  if (Number.isFinite(shortest)) info(`shortest cue ${shortest} ms`);
  info(`  ${basename(result.outputs.targetSrt)}`);
  info(`  ${basename(result.outputs.sourceSrt)}`);
  info(`  ${basename(result.outputs.segmentsJson)}`);
  if (result.serviceId) info(`  service ${result.serviceId}`);
}

async function runExport(positional: string[], flags: ParsedArgs['flags'], config: AppConfig) {
  const ref = firstPositional(positional, 'video path or service id');
  const result = await withDb(config, (prisma) =>
    exportSrt({ ref, outDir: optionalString(flags, 'out-dir') }, config, prisma),
  );
  info(`  ${basename(result.targetSrt)}`);
  info(`  ${basename(result.sourceSrt)}`);
}

async function runPublish(positional: string[], flags: ParsedArgs['flags'], config: AppConfig) {
  if (flags.get('auth') === true) {
    const credentials = resolveYoutubeCredentials(config, process.env, {
      requireRefreshToken: false,
    });
    const refreshToken = await authorise({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      port: config.youtube.authPort,
      onUrl: (url) => {
        info('Open this in a browser and approve access:');
        info('');
        process.stdout.write(`${url}\n\n`);
      },
    });
    info('Paste this into .env:');
    process.stdout.write(`${config.youtube.refreshTokenEnv}=${refreshToken}\n`);
    info('');
    info('Set the OAuth consent screen to Production, or this token expires in 7 days.');
    return;
  }

  const dryRun = flags.get('dry-run') === true;
  // --dry-run resolves and formats everything but never calls the API, so it
  // must work with no credentials at all.
  const client = dryRun
    ? undefined
    : createYoutubeClient(resolveYoutubeCredentials(config, process.env));

  if (flags.get('all') === true) {
    const result = await withDb(config, (prisma) =>
      publishAll(
        {
          budget: optionalNumber(flags, 'budget'),
          force: flags.get('force') === true,
          dryRun,
        },
        config,
        prisma,
        client,
      ),
    );
    if (result.stoppedOnQuota) {
      info('Re-run the same command tomorrow — it picks up where this stopped.');
    }
    return;
  }

  const ref = firstPositional(positional, 'video path or service id');
  const result = await withDb(config, (prisma) =>
    publish(
      {
        ref,
        youtubeVideoId: optionalString(flags, 'youtube-id'),
        force: flags.get('force') === true,
        dryRun,
      },
      config,
      prisma,
      client,
    ),
  );

  info('');
  info(`https://youtu.be/${result.youtubeVideoId}`);
  for (const track of result.tracks) {
    info(`  ${track.language}: ${track.action}`);
  }
  if (result.quotaUnits > 0) info(`${result.quotaUnits} quota units`);
}

async function runEdit(positional: string[], flags: ParsedArgs['flags'], config: AppConfig) {
  const ref = firstPositional(positional, 'video path or service id');
  const cue = optionalNumber(flags, 'cue');
  if (cue === undefined) throw new Error('--cue is required');
  const text = requireString(flags, 'text');

  const result = await withDb(config, (prisma) =>
    editTranslation({ ref, cue, text, editedBy: optionalString(flags, 'edited-by') }, prisma),
  );

  if (result.unchanged) {
    info(`cue ${cue} already reads exactly that — nothing changed`);
    return;
  }
  info(`cue ${cue} updated`);
  info(`  was: ${result.before}`);
  info(`  now: ${result.after}`);
  info('');
  info('Run `export` to regenerate the SRT with this correction.');
}

async function runShow(positional: string[], flags: ParsedArgs['flags'], config: AppConfig) {
  const ref = firstPositional(positional, 'video path or service id');
  const { total, rows } = await withDb(config, (prisma) =>
    showSegments(
      { ref, from: optionalNumber(flags, 'from'), limit: optionalNumber(flags, 'limit') },
      prisma,
    ),
  );
  for (const row of rows) {
    const mark = row.editedAt ? ` (edited by ${row.editedBy})` : '';
    process.stdout.write(`${row.index + 1}. [${row.startMs}–${row.endMs}ms]${mark}\n`);
    process.stdout.write(`   gu: ${row.original}\n`);
    process.stdout.write(`   en: ${row.translation}\n`);
    if (row.previousTranslation) {
      process.stdout.write(`   was: ${row.previousTranslation}\n`);
    }
  }
  info(`${rows.length} of ${total} cues`);
}

async function runList(config: AppConfig) {
  const services = await withDb(config, listAllServices);
  if (services.length === 0) {
    info('no services yet — run `ingest` first');
    return;
  }
  for (const service of services) {
    process.stdout.write(
      `${service.date}  ${String(service.cues).padStart(5)} cues  ${service.speaker}\n`,
    );
    process.stdout.write(`  ${service.id}  ${service.videoPath}\n`);
  }
}

async function runBackfill(positional: string[], flags: ParsedArgs['flags'], config: AppConfig) {
  const dir = firstPositional(positional, 'directory');
  const results = await withDb(config, (prisma) =>
    backfill(
      {
        dir,
        speaker: requireString(flags, 'speaker'),
        date: optionalString(flags, 'date'),
        limit: optionalNumber(flags, 'limit'),
        only: optionalString(flags, 'only'),
        retryFailed: flags.get('retry-failed') === true,
        redo: flags.get('redo') === true,
      },
      config,
      prisma,
    ),
  );
  // A batch with failures must not report success — phase 4 runs unattended.
  if (results.some((entry) => entry.outcome === 'failed')) throw new Error('some files failed');
}

async function runIndexCommand(positional: string[], config: AppConfig) {
  await withDb(config, (prisma) => runIndex({ ref: positional[0] }, config, prisma));
}

async function runSearchCommand(
  positional: string[],
  flags: ParsedArgs['flags'],
  config: AppConfig,
) {
  const query = firstPositional(positional, 'search query');
  const hits = await withDb(config, (prisma) =>
    runSearch({ query, limit: optionalNumber(flags, 'limit') }, config, prisma),
  );
  if (hits.length === 0) {
    info('no matches — has `index` been run?');
    return;
  }
  for (const hit of hits) process.stdout.write(`${formatHit(hit)}\n`);
}

async function runPlayCommand(
  positional: string[],
  flags: ParsedArgs['flags'],
  config: AppConfig,
) {
  const ref = firstPositional(positional, 'video path or service id');
  await withDb(config, (prisma) =>
    runPlay(
      {
        ref,
        input: requireString(flags, 'input'),
        vmixUrl: optionalString(flags, 'vmix-url'),
        captionInput: optionalString(flags, 'caption-input'),
        lines: optionalString(flags, 'lines') === 'both' ? 'both' : 'en',
        token: optionalString(flags, 'token'),
      },
      config,
      prisma,
    ),
  );
}

async function runLiveCommand(flags: ParsedArgs['flags'], config: AppConfig) {
  await runLive(
    {
      device: requireString(flags, 'device'),
      format: optionalString(flags, 'format') as CaptureFormat | undefined,
      outputs: optionalString(flags, 'outputs')
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean) as Parameters<typeof runLive>[0]['outputs'],
      recordPath: optionalString(flags, 'record'),
      token: optionalString(flags, 'token'),
      youtubeCaptionsUrl: optionalString(flags, 'youtube-captions'),
      streamOffsetMs: optionalNumber(flags, 'stream-offset'),
      captionInput: optionalString(flags, 'caption-input'),
      verbose: flags.get('verbose') === true,
    },
    config,
  );
}

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const { command, positional, flags } = parseArgv(argv);

  if (flags.has('help') || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  const configPath = flags.get('config');
  const config = loadConfig(typeof configPath === 'string' ? configPath : 'config.json');

  switch (command) {
    case 'ingest':
      await runIngest(positional, flags, config);
      return 0;
    case 'export':
      await runExport(positional, flags, config);
      return 0;
    case 'publish':
      await runPublish(positional, flags, config);
      return 0;
    case 'edit':
      await runEdit(positional, flags, config);
      return 0;
    case 'show':
      await runShow(positional, flags, config);
      return 0;
    case 'list':
      await runList(config);
      return 0;
    case 'backfill':
      await runBackfill(positional, flags, config);
      return 0;
    case 'index':
      await runIndexCommand(positional, config);
      return 0;
    case 'search':
      await runSearchCommand(positional, flags, config);
      return 0;
    case 'play':
      await runPlayCommand(positional, flags, config);
      return 0;
    case 'live':
      await runLiveCommand(flags, config);
      return 0;
    case 'devices':
      process.stdout.write(`${listDevicesCommand()}\n`);
      return 0;
    default:
      fail(`unknown command "${command}"`);
      process.stdout.write(USAGE);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof EditsWouldBeLostError) {
      fail(err.message);
    } else if (err instanceof ConfigError || err instanceof DatabaseError) {
      fail(err.message);
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  });
