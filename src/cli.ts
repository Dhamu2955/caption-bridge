#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { ConfigError, loadConfig } from './config.js';
import { ingest } from './commands/ingest.js';
import { fail, info, warn } from './util/log.js';

const USAGE = `sermon-captions — Gujarati→English sermon subtitles

Usage:
  sermon-captions ingest <video> --speaker <name> --date <YYYY-MM-DD> [options]

Options:
  --speaker <name>   Who is speaking. Recorded in the segments file.
  --date <date>      Service date, YYYY-MM-DD.
  --force            Re-transcribe even if a cached transcript exists.
  --config <path>    Config file (default: config.json).
  -h, --help         Show this help.

Writes <basename>.en.srt, <basename>.gu.srt and <basename>.segments.json
beside the video. Needs SONIOX_API_KEY in the environment.
`;

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

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

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
    if (name === 'force' || name === 'help' || next === undefined || next.startsWith('--')) {
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

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const { command, positional, flags } = parseArgv(argv);

  if (flags.has('help') || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command !== 'ingest') {
    fail(`unknown command "${command}"`);
    process.stdout.write(USAGE);
    return 1;
  }

  const videoPath = positional[0];
  if (!videoPath) throw new Error('a video file is required: sermon-captions ingest <video> …');

  const speaker = requireString(flags, 'speaker');
  const date = requireString(flags, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  }

  const configPath = flags.get('config');
  const config = loadConfig(typeof configPath === 'string' ? configPath : 'config.json');

  const result = await ingest(
    { videoPath, speaker, date, force: flags.get('force') === true },
    config,
  );

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
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) fail(err.message);
    else fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
