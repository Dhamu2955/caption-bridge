import type { PrismaClient } from '../generated/prisma/client.js';
import type { Segment } from '../segments/types.js';

/**
 * Service + segment persistence. INVARIANT 2: this is the source of truth.
 * SRT is regenerated from here, never read back.
 */

/** Editor identity. Hardcoded until auth exists (§9) — see MACHINE_AUTHOR. */
export const LOCAL_AUTHOR = 'local';
/** Attribution for text exactly as transcribed, never touched by a human. */
export const MACHINE_AUTHOR = 'soniox';

export interface ServiceInput {
  date: string;
  speaker: string;
  title?: string | undefined;
  source?: 'rip' | 'live';
  videoPath: string;
  durationMs?: number | null | undefined;
  trimStartMs?: number;
}

export interface StoredSegment {
  index: number;
  startMs: number;
  endMs: number;
  original: string;
  translation: string;
  speaker: string | null;
  editedBy: string;
  editedAt: Date | null;
  previousTranslation: string | null;
}

/** A YYYY-MM-DD service date is a calendar date, not an instant — pin it to
 *  UTC midnight so it cannot drift a day either side with the local zone. */
export function toServiceDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function formatServiceDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Write a freshly ingested service and its segments.
 *
 * Re-ingesting the same video replaces its segments wholesale — the transcript
 * is machine output and carries no corrections worth preserving. Any human
 * edits ARE discarded, so this refuses to run when edits exist unless the
 * caller explicitly opts in.
 */
export async function saveService(
  prisma: PrismaClient,
  input: ServiceInput,
  segments: Segment[],
  options: { replaceEdited?: boolean } = {},
): Promise<{ serviceId: string; created: boolean; discardedEdits: number }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.service.findUnique({
      where: { videoPath: input.videoPath },
      select: { id: true },
    });

    const edits = existing
      ? await tx.segment.count({
          where: { serviceId: existing.id, editedAt: { not: null } },
        })
      : 0;

    if (edits > 0 && options.replaceEdited !== true) {
      throw new EditsWouldBeLostError(edits);
    }

    const data = {
      date: toServiceDate(input.date),
      speaker: input.speaker,
      title: input.title ?? null,
      source: input.source ?? ('rip' as const),
      durationMs: input.durationMs ?? null,
      trimStartMs: input.trimStartMs ?? 0,
    };

    const service = existing
      ? await tx.service.update({ where: { id: existing.id }, data })
      : await tx.service.create({ data: { ...data, videoPath: input.videoPath } });

    await tx.segment.deleteMany({ where: { serviceId: service.id } });
    if (segments.length > 0) {
      await tx.segment.createMany({
        data: segments.map((segment) => ({
          serviceId: service.id,
          index: segment.index,
          original: segment.original,
          translation: segment.translation,
          startMs: segment.startMs,
          endMs: segment.endMs,
          speaker: segment.speaker ?? null,
          editedBy: MACHINE_AUTHOR,
        })),
      });
    }

    return { serviceId: service.id, created: existing === null, discardedEdits: edits };
  });
}

export class EditsWouldBeLostError extends Error {
  readonly edits: number;
  constructor(edits: number) {
    super(
      `${edits} hand-corrected segment${edits === 1 ? '' : 's'} would be discarded. ` +
        `Pass --replace-edited if that is what you want.`,
    );
    this.name = 'EditsWouldBeLostError';
    this.edits = edits;
  }
}

export async function findService(
  prisma: PrismaClient,
  ref: { id?: string; videoPath?: string },
) {
  if (ref.id) return prisma.service.findUnique({ where: { id: ref.id } });
  if (ref.videoPath) return prisma.service.findUnique({ where: { videoPath: ref.videoPath } });
  return null;
}

export async function listServices(prisma: PrismaClient) {
  return prisma.service.findMany({
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    include: { _count: { select: { segments: true } } },
  });
}

/** The SELECT half of "SRT export becomes SELECT → format" (§4). */
export async function loadSegments(
  prisma: PrismaClient,
  serviceId: string,
): Promise<StoredSegment[]> {
  const rows = await prisma.segment.findMany({
    where: { serviceId },
    orderBy: { index: 'asc' },
    select: {
      index: true,
      startMs: true,
      endMs: true,
      original: true,
      translation: true,
      speaker: true,
      editedBy: true,
      editedAt: true,
      previousTranslation: true,
    },
  });
  return rows;
}

/**
 * Correct a translation.
 *
 * Records who and when, and keeps the text being replaced — §4 calls that the
 * whole reason the database is the source of truth. Re-editing an already
 * edited segment keeps the ORIGINAL machine output in previousTranslation
 * rather than the intermediate correction, so the machine baseline is never
 * lost behind a chain of edits.
 */
export async function editSegment(
  prisma: PrismaClient,
  serviceId: string,
  index: number,
  translation: string,
  editedBy: string = LOCAL_AUTHOR,
): Promise<{ before: string; after: string } | null> {
  const segment = await prisma.segment.findUnique({
    where: { serviceId_index: { serviceId, index } },
    select: { id: true, translation: true, previousTranslation: true, editedAt: true },
  });
  if (!segment) return null;
  if (segment.translation === translation) {
    return { before: segment.translation, after: translation };
  }

  await prisma.segment.update({
    where: { id: segment.id },
    data: {
      translation,
      editedBy,
      editedAt: new Date(),
      previousTranslation:
        segment.editedAt === null ? segment.translation : segment.previousTranslation,
    },
  });

  return { before: segment.translation, after: translation };
}
