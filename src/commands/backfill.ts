import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { findService } from '../db/services.js';
import { ingest } from './ingest.js';
import { info, warn } from '../util/log.js';

/**
 * §4 phase 4: the same ingest tool pointed at the archive, with
 * resume-on-failure.
 *
 * Before any bulk run, push the three WORST-quality recordings through first
 * and read the output — old room-mic audio may be unusable, which would scope
 * the backfill to whatever era has a clean desk feed. `--limit` and `--only`
 * exist for exactly that.
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.webm', '.avi', '.mp3', '.m4a', '.wav']);

export type BackfillOutcome = 'ingested' | 'skipped' | 'failed';

export interface BackfillEntry {
  file: string;
  outcome: BackfillOutcome;
  serviceId?: string;
  cues?: number;
  error?: string;
}

/** Written after every file so an interrupted run resumes where it stopped. */
export interface BackfillState {
  entries: Record<string, { outcome: BackfillOutcome; serviceId?: string; cues?: number; error?: string }>;
}

export interface BackfillArgs {
  dir: string;
  speaker: string;
  /** Files whose name has no parseable date fall back to this. */
  date?: string | undefined;
  limit?: number | undefined;
  /** Substring filter, for the worst-recordings spike. */
  only?: string | undefined;
  /** Retry files that previously failed. */
  retryFailed?: boolean;
  /** Re-ingest files already in the database. */
  redo?: boolean;
  statePath?: string | undefined;
}

/** `sermon-2026-08-16.mp4` → `2026-08-16`. */
export function dateFromFilename(file: string): string | undefined {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(basename(file));
  if (!match) return undefined;
  const [, y, m, d] = match;
  const iso = `${y}-${m}-${d}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (parsed.toISOString().slice(0, 10) !== iso) return undefined;
  return iso;
}

export async function findVideos(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(dir, entry.name))
    .sort();
}

async function readState(path: string): Promise<BackfillState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BackfillState;
    if (parsed && typeof parsed === 'object' && parsed.entries) return parsed;
  } catch {
    // A missing or corrupt state file just means starting fresh.
  }
  return { entries: {} };
}

async function writeState(path: string, state: BackfillState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function backfill(
  args: BackfillArgs,
  config: AppConfig,
  prisma: PrismaClient,
): Promise<BackfillEntry[]> {
  const dir = resolve(args.dir);
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);

  const statePath = args.statePath ? resolve(args.statePath) : join(dir, '.backfill-state.json');
  const state = await readState(statePath);

  let files = await findVideos(dir);
  if (args.only) {
    const needle = args.only.toLowerCase();
    files = files.filter((file) => basename(file).toLowerCase().includes(needle));
  }
  if (files.length === 0) {
    info(`no video files found in ${dir}`);
    return [];
  }

  const results: BackfillEntry[] = [];
  let processed = 0;

  for (const file of files) {
    if (args.limit !== undefined && processed >= args.limit) break;

    const key = basename(file);
    const previous = state.entries[key];

    // Resume: skip anything already done, unless explicitly asked to redo.
    if (previous?.outcome === 'ingested' && !args.redo) {
      results.push({ ...previous, file, outcome: 'skipped' });
      continue;
    }
    if (previous?.outcome === 'failed' && !args.retryFailed && !args.redo) {
      info(`skipping previously failed ${key} (--retry-failed to try again)`);
      results.push({ file, outcome: 'skipped', error: previous.error });
      continue;
    }
    if (!args.redo && (await findService(prisma, { videoPath: file }))) {
      state.entries[key] = { outcome: 'ingested' };
      await writeState(statePath, state);
      results.push({ file, outcome: 'skipped' });
      continue;
    }

    const date = dateFromFilename(file) ?? args.date;
    if (!date) {
      const error = 'no date in filename and no --date given';
      warn(`${key}: ${error}`);
      state.entries[key] = { outcome: 'failed', error };
      await writeState(statePath, state);
      results.push({ file, outcome: 'failed', error });
      processed++;
      continue;
    }

    processed++;
    info(`[${processed}] ${key} (${date})`);

    try {
      const result = await ingest(
        {
          videoPath: file,
          speaker: args.speaker,
          date,
          force: false,
          replaceEdited: args.redo === true,
        },
        config,
        prisma,
      );
      const entry = {
        outcome: 'ingested' as const,
        ...(result.serviceId ? { serviceId: result.serviceId } : {}),
        cues: result.segments.length,
      };
      state.entries[key] = entry;
      results.push({ file, ...entry });
      info(`    ${result.segments.length} cues`);
    } catch (err) {
      // One bad file must not end the run — that is the whole point of resume.
      const error = err instanceof Error ? err.message : String(err);
      warn(`${key} failed: ${error}`);
      state.entries[key] = { outcome: 'failed', error };
      results.push({ file, outcome: 'failed', error });
    }

    await writeState(statePath, state);
  }

  const ingested = results.filter((r) => r.outcome === 'ingested').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  info('');
  info(`${ingested} ingested, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) info(`state written to ${statePath} — re-run with --retry-failed`);

  return results;
}
