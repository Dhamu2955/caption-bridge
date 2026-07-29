#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { DatabaseError, resolveDatabaseUrl, withPrisma } from './db/client.js';
import { EditsWouldBeLostError } from './db/services.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { ingest } from './commands/ingest.js';
import { exportSrt } from './commands/export.js';
import { editTranslation, listAllServices, showSegments } from './commands/edit.js';
import { fail, info, warn } from './util/log.js';

const USAGE = `sermon-captions — Gujarati→English sermon subtitles

Usage:
  sermon-captions ingest <video> --speaker <name> --date <YYYY-MM-DD> [options]
  sermon-captions export <video|service-id> [--out-dir <dir>]
  sermon-captions edit   <video|service-id> --cue <n> --text "corrected text"
  sermon-captions show   <video|service-id> [--from <n>] [--limit <n>]
  sermon-captions list

ingest options:
  --speaker <name>    Who is speaking. Required.
  --date <date>       Service date, YYYY-MM-DD. Required.
  --title <text>      Optional service title.
  --force             Re-transcribe even if a cached transcript exists.
  --no-db             Write files only; do not touch the database.
  --replace-edited    Overwrite segments even if they carry human corrections.

Common:
  --config <path>     Config file (default: config.json).
  -h, --help          Show this help.

Subtitles are generated artifacts — correct them with \`edit\`, then re-run
\`export\`. Never hand-edit an SRT; the next export overwrites it.

Needs SONIOX_API_KEY to ingest, and DATABASE_URL for everything else.
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['force', 'help', 'no-db', 'replace-edited']);

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
    case 'edit':
      await runEdit(positional, flags, config);
      return 0;
    case 'show':
      await runShow(positional, flags, config);
      return 0;
    case 'list':
      await runList(config);
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
