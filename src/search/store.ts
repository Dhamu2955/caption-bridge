import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadSegments } from '../db/services.js';
import type { Segment } from '../segments/types.js';
import { chunkSegments, type ChunkOptions } from './chunk.js';
import { toVectorLiteral, type Embedder } from './embedder.js';

/**
 * Chunk storage and vector search. The embedding column has no Prisma type, so
 * writes and similarity queries go through raw SQL.
 */

export interface IndexResult {
  serviceId: string;
  chunks: number;
  vectors: number;
}

export interface SearchHit {
  serviceId: string;
  serviceDate: Date;
  speaker: string;
  videoPath: string;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  original: string;
  translation: string;
  /** Language of the indexed text that matched, not of the query. */
  language: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export async function indexService(
  prisma: PrismaClient,
  serviceId: string,
  embedder: Embedder,
  chunkOptions?: ChunkOptions,
): Promise<IndexResult> {
  const rows = await loadSegments(prisma, serviceId);
  const segments: Segment[] = rows.map((row) => ({
    index: row.index,
    startMs: row.startMs,
    endMs: row.endMs,
    original: row.original,
    translation: row.translation,
    speaker: row.speaker ?? undefined,
  }));

  const chunks = chunkSegments(segments, chunkOptions);

  // Re-indexing replaces wholesale; chunks are derived data with nothing worth
  // preserving. Cascade clears the embeddings.
  await prisma.chunk.deleteMany({ where: { serviceId } });
  if (chunks.length === 0) return { serviceId, chunks: 0, vectors: 0 };

  await prisma.chunk.createMany({
    data: chunks.map((chunk) => ({
      serviceId,
      index: chunk.index,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      firstSegmentIndex: chunk.firstSegmentIndex,
      lastSegmentIndex: chunk.lastSegmentIndex,
      original: chunk.original,
      translation: chunk.translation,
    })),
  });

  const stored = await prisma.chunk.findMany({
    where: { serviceId },
    select: { id: true, index: true },
    orderBy: { index: 'asc' },
  });
  const idByIndex = new Map(stored.map((row) => [row.index, row.id]));

  // Both languages per chunk (§3) — a Gujarati query should be able to land on
  // an English-indexed passage and vice versa.
  const originals = await embedder.embedPassages(chunks.map((c) => c.original));
  const translations = await embedder.embedPassages(chunks.map((c) => c.translation));

  let vectors = 0;
  for (const [i, chunk] of chunks.entries()) {
    const chunkId = idByIndex.get(chunk.index);
    if (!chunkId) continue;
    for (const [language, vector] of [
      ['original', originals[i]],
      ['translation', translations[i]],
    ] as const) {
      if (!vector) continue;
      await prisma.$executeRaw`
        INSERT INTO "ChunkEmbedding" ("id", "chunkId", "language", "model", "embedding")
        VALUES (gen_random_uuid(), ${chunkId}, ${language}, ${embedder.id},
                ${toVectorLiteral(vector)}::vector)
        ON CONFLICT ("chunkId", "language", "model")
        DO UPDATE SET "embedding" = EXCLUDED."embedding"
      `;
      vectors++;
    }
  }

  return { serviceId, chunks: chunks.length, vectors };
}

export interface SearchOptions {
  limit?: number;
  serviceId?: string | undefined;
}

export async function search(
  prisma: PrismaClient,
  query: string,
  embedder: Embedder,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = Math.max(1, options.limit ?? 10);
  const vector = toVectorLiteral(await embedder.embedQuery(query));

  // Best-scoring language per chunk: a chunk that matches in both languages
  // should appear once, at its strongest score, not twice.
  const rows = await prisma.$queryRaw<
    {
      serviceId: string;
      serviceDate: Date;
      speaker: string;
      videoPath: string;
      chunkIndex: number;
      startMs: number;
      endMs: number;
      original: string;
      translation: string;
      language: string;
      distance: number;
    }[]
  >`
    SELECT DISTINCT ON (c."id")
      s."id"          AS "serviceId",
      s."date"        AS "serviceDate",
      s."speaker"     AS "speaker",
      s."videoPath"   AS "videoPath",
      c."index"       AS "chunkIndex",
      c."startMs"     AS "startMs",
      c."endMs"       AS "endMs",
      c."original"    AS "original",
      c."translation" AS "translation",
      e."language"    AS "language",
      (e."embedding" <=> ${vector}::vector) AS "distance"
    FROM "ChunkEmbedding" e
    JOIN "Chunk" c   ON c."id" = e."chunkId"
    JOIN "Service" s ON s."id" = c."serviceId"
    WHERE e."model" = ${embedder.id}
      AND (${options.serviceId ?? null}::text IS NULL OR s."id" = ${options.serviceId ?? null}::text)
    ORDER BY c."id", "distance" ASC
  `;

  return rows
    .map((row) => ({
      serviceId: row.serviceId,
      serviceDate: row.serviceDate,
      speaker: row.speaker,
      videoPath: row.videoPath,
      chunkIndex: row.chunkIndex,
      startMs: row.startMs,
      endMs: row.endMs,
      original: row.original,
      translation: row.translation,
      language: row.language,
      // pgvector's <=> is cosine DISTANCE; report similarity, which reads the
      // right way round for a human.
      score: 1 - Number(row.distance),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function indexedServiceIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.chunk.findMany({
    distinct: ['serviceId'],
    select: { serviceId: true },
  });
  return rows.map((row) => row.serviceId);
}

/** Present so a future migration can detect a model change explicitly. */
export async function modelsInUse(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ model: string }[]>(
    Prisma.sql`SELECT DISTINCT "model" FROM "ChunkEmbedding"`,
  );
  return rows.map((row) => row.model);
}
