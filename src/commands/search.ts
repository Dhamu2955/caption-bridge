import { resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { findService, listServices } from '../db/services.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { deepLink } from '../search/chunk.js';
import { LocalEmbedder, type Embedder } from '../search/embedder.js';
import { indexService, search, type SearchHit } from '../search/store.js';
import { info } from '../util/log.js';

export function createEmbedder(config: AppConfig): Embedder {
  return new LocalEmbedder(config.search.model, config.search.dimensions);
}

export interface IndexArgs {
  /** Video path, service id, or omitted for every service. */
  ref?: string | undefined;
}

export async function runIndex(
  args: IndexArgs,
  config: AppConfig,
  prisma: PrismaClient,
  embedder: Embedder = createEmbedder(config),
) {
  const targets: { id: string; label: string }[] = [];

  if (args.ref) {
    const service =
      (await findService(prisma, { videoPath: resolve(args.ref) })) ??
      (await findService(prisma, { id: args.ref }));
    if (!service) throw new Error(`no service found for "${args.ref}"`);
    targets.push({ id: service.id, label: service.videoPath });
  } else {
    for (const service of await listServices(prisma)) {
      targets.push({ id: service.id, label: service.videoPath });
    }
  }

  if (targets.length === 0) {
    info('no services to index — run `ingest` first');
    return [];
  }

  const chunkOptions = {
    targetMs: config.search.chunkTargetMs,
    maxMs: config.search.chunkMaxMs,
    overlapMs: config.search.chunkOverlapMs,
  };

  const results = [];
  for (const target of targets) {
    const result = await indexService(prisma, target.id, embedder, chunkOptions);
    info(`${result.chunks} chunks, ${result.vectors} vectors — ${target.label}`);
    results.push(result);
  }
  return results;
}

export interface SearchArgs {
  query: string;
  limit?: number | undefined;
  serviceId?: string | undefined;
}

export async function runSearch(
  args: SearchArgs,
  config: AppConfig,
  prisma: PrismaClient,
  embedder: Embedder = createEmbedder(config),
): Promise<SearchHit[]> {
  return search(prisma, args.query, embedder, {
    limit: args.limit ?? 10,
    serviceId: args.serviceId,
  });
}

export function formatHit(hit: SearchHit): string {
  const seconds = Math.floor(hit.startMs / 1000);
  const clock = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(
    Math.floor(seconds / 60) % 60,
  ).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const date = hit.serviceDate.toISOString().slice(0, 10);
  const excerpt = hit.translation.length > 220 ? `${hit.translation.slice(0, 217)}…` : hit.translation;
  return (
    `${hit.score.toFixed(3)}  ${date}  ${clock}  ${hit.speaker}\n` +
    `  ${excerpt}\n` +
    `  ${deepLink(hit.videoPath, hit.startMs)}\n`
  );
}
