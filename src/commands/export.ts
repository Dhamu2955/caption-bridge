import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadSegments, resolveServiceRef, type StoredSegment } from '../db/services.js';
import type { Segment } from '../segments/types.js';
import { toSrt } from '../srt/format.js';
import { info } from '../util/log.js';

export interface ExportArgs {
  /** Video path or service id. */
  ref: string;
  /** Defaults to the directory holding the video. */
  outDir?: string | undefined;
}

export interface ExportResult {
  serviceId: string;
  targetSrt: string;
  sourceSrt: string;
  cues: number;
  editedCues: number;
}

/**
 * §4 phase 2: "SRT export becomes SELECT → format."
 *
 * INVARIANT 1: `trimStartMs` is subtracted here. On the happy path it is 0
 * because the video was trimmed before transcription, so this is a no-op —
 * but it is the one place an untrimmed file gets reconciled.
 */
export function toExportSegments(rows: StoredSegment[], trimStartMs: number): Segment[] {
  return rows.map((row) => ({
    index: row.index,
    startMs: Math.max(0, row.startMs - trimStartMs),
    endMs: Math.max(0, row.endMs - trimStartMs),
    original: row.original,
    translation: row.translation,
    speaker: row.speaker ?? undefined,
  }));
}

/**
 * The formatting half of export, with no I/O.
 *
 * `publish` uploads exactly these bytes to YouTube rather than reading an
 * `.srt` back off disk — INVARIANT 2 makes the database the source of truth,
 * and a file someone hand-edited is not it.
 */
export function buildSrtTexts(
  rows: StoredSegment[],
  trimStartMs: number,
  config: AppConfig,
): { target: string; source: string } {
  const segments = toExportSegments(rows, trimStartMs);
  const srtOptions = {
    maxLineChars: config.ingest.maxLineChars,
    maxLines: config.ingest.maxLines,
  };
  return {
    target: toSrt(segments, 'translation', srtOptions),
    source: toSrt(segments, 'original', srtOptions),
  };
}

export async function exportSrt(
  args: ExportArgs,
  config: AppConfig,
  prisma: PrismaClient,
): Promise<ExportResult> {
  const service = await resolveServiceRef(prisma, args.ref);

  const rows = await loadSegments(prisma, service.id);
  const segments = toExportSegments(rows, service.trimStartMs);
  const texts = buildSrtTexts(rows, service.trimStartMs, config);

  const dir = args.outDir ? resolve(args.outDir) : dirname(service.videoPath);
  const stem = basename(service.videoPath, extname(service.videoPath));
  const targetSrt = join(dir, `${stem}.${config.soniox.targetLanguage}.srt`);
  const sourceSrt = join(dir, `${stem}.${config.soniox.sourceLanguages[0] ?? 'src'}.srt`);

  await writeFile(targetSrt, texts.target, 'utf8');
  await writeFile(sourceSrt, texts.source, 'utf8');

  const editedCues = rows.filter((row) => row.editedAt !== null).length;
  info(`exported ${segments.length} cues${editedCues > 0 ? ` (${editedCues} hand-corrected)` : ''}`);

  return { serviceId: service.id, targetSrt, sourceSrt, cues: segments.length, editedCues };
}
