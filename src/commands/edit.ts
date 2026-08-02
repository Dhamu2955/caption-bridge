import type { PrismaClient } from '../generated/prisma/client.js';
import {
  editSegment,
  formatServiceDate,
  listServices,
  loadSegments,
  resolveServiceRef,
} from '../db/services.js';

export interface EditArgs {
  /** Video path or service id. */
  ref: string;
  /** Cue number as shown in the SRT — 1-based. */
  cue: number;
  text: string;
  editedBy?: string | undefined;
}

/**
 * Correct one translation. §8: corrections go in the database, never into a
 * hand-edited SRT — re-export afterwards to get the fix on screen.
 *
 * Cue numbers are 1-based to match the SRT the reviewer is reading from;
 * segment indexes are 0-based internally.
 */
export async function editTranslation(
  args: EditArgs,
  prisma: PrismaClient,
): Promise<{ serviceId: string; before: string; after: string; unchanged: boolean }> {
  const service = await resolveServiceRef(prisma, args.ref);

  if (!Number.isInteger(args.cue) || args.cue < 1) {
    throw new Error(`--cue must be a whole number of 1 or more, got "${args.cue}"`);
  }

  const result = await editSegment(
    prisma,
    service.id,
    args.cue - 1,
    args.text,
    args.editedBy,
  );
  if (!result) {
    const total = (await loadSegments(prisma, service.id)).length;
    throw new Error(`cue ${args.cue} does not exist — this service has ${total} cues`);
  }

  return {
    serviceId: service.id,
    before: result.before,
    after: result.after,
    unchanged: result.before === result.after,
  };
}

export interface ShowArgs {
  ref: string;
  from?: number | undefined;
  limit?: number | undefined;
}

/** Read cues back, so a correction can be checked without opening the SRT. */
export async function showSegments(args: ShowArgs, prisma: PrismaClient) {
  const service = await resolveServiceRef(prisma, args.ref);
  const rows = await loadSegments(prisma, service.id);
  const from = Math.max(1, args.from ?? 1);
  const limit = Math.max(1, args.limit ?? 20);
  return {
    service,
    total: rows.length,
    rows: rows.slice(from - 1, from - 1 + limit),
  };
}

export async function listAllServices(prisma: PrismaClient) {
  const services = await listServices(prisma);
  return services.map((service) => ({
    id: service.id,
    date: formatServiceDate(service.date),
    speaker: service.speaker,
    title: service.title,
    videoPath: service.videoPath,
    cues: service._count.segments,
  }));
}
