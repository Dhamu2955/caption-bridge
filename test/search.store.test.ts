import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPrisma } from '../src/db/client.js';
import { saveService } from '../src/db/services.js';
import { HashEmbedder } from '../src/search/embedder.js';
import { indexService, search } from '../src/search/store.js';
import { backfill, dateFromFilename, findVideos } from '../src/commands/backfill.js';
import { parseConfig } from '../src/config.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { Segment } from '../src/segments/types.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Hash embedder: no model download, exercises the SQL and storage paths. */
const embedder = new HashEmbedder(384);

function segments(texts: [string, string][]): Segment[] {
  return texts.map(([original, translation], i) => ({
    index: i,
    startMs: i * 5000,
    endMs: i * 5000 + 4800,
    original,
    translation,
    speaker: '1',
  }));
}

describeDb('vector storage and retrieval', () => {
  let prisma: PrismaClient;
  let dir = '';
  const created: string[] = [];

  beforeAll(async () => {
    prisma = createPrisma(DATABASE_URL as string);
    dir = await mkdtemp(join(tmpdir(), 'sermon-search-'));
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.service.deleteMany({ where: { id: { in: created.splice(0) } } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(name: string, texts: [string, string][]) {
    const { serviceId } = await saveService(
      prisma,
      { date: '2026-08-16', speaker: 'Swami Ji', videoPath: join(dir, `${name}.mp4`) },
      segments(texts),
    );
    created.push(serviceId);
    return serviceId;
  }

  it('stores one vector per language per chunk (§3)', async () => {
    const serviceId = await seed('a', [
      ['ભક્તિ એ માર્ગ છે', 'Devotion is the path'],
      ['સેવા કરો', 'Perform service'],
    ]);
    const result = await indexService(prisma, serviceId, embedder, {
      targetMs: 60_000,
      maxMs: 120_000,
      overlapMs: 0,
    });
    expect(result.chunks).toBe(1);
    expect(result.vectors).toBe(2);
  });

  it('finds the chunk containing a phrase', async () => {
    const serviceId = await seed('b', [
      ['એક', 'The scriptures speak of devotion'],
      ['બે', 'Completely unrelated administrative notices'],
    ]);
    await indexService(prisma, serviceId, embedder, {
      targetMs: 4000,
      maxMs: 6000,
      overlapMs: 0,
    });
    const hits = await search(prisma, 'scriptures speak of devotion', embedder, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.translation).toContain('scriptures speak of devotion');
  });

  it('returns each chunk once, at its best-scoring language', async () => {
    const serviceId = await seed('c', [['ભક્તિ', 'devotion']]);
    await indexService(prisma, serviceId, embedder);
    const hits = await search(prisma, 'devotion', embedder, { limit: 10 });
    const ids = hits.map((hit) => `${hit.serviceId}:${hit.chunkIndex}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the seek target through to the hit', async () => {
    const serviceId = await seed('d', [
      ['એક', 'first passage about nothing'],
      ['બે', 'second passage about devotion'],
    ]);
    await indexService(prisma, serviceId, embedder, {
      targetMs: 4000,
      maxMs: 6000,
      overlapMs: 0,
    });
    const hits = await search(prisma, 'second passage about devotion', embedder, { limit: 1 });
    expect(hits[0]?.startMs).toBe(5000);
  });

  it('re-indexing replaces rather than duplicating', async () => {
    const serviceId = await seed('e', [['એક', 'one']]);
    await indexService(prisma, serviceId, embedder);
    const second = await indexService(prisma, serviceId, embedder);
    expect(second.chunks).toBe(1);
    expect(await prisma.chunk.count({ where: { serviceId } })).toBe(1);
  });

  it('can restrict a search to one service', async () => {
    const a = await seed('f', [['એક', 'devotion in service A']]);
    await seed('g', [['એક', 'devotion in service B']]);
    await indexService(prisma, a, embedder);
    const hits = await search(prisma, 'devotion', embedder, { serviceId: a });
    expect(hits.every((hit) => hit.serviceId === a)).toBe(true);
  });

  it('deletes chunks and vectors with the service', async () => {
    const serviceId = await seed('h', [['એક', 'one']]);
    await indexService(prisma, serviceId, embedder);
    await prisma.service.delete({ where: { id: serviceId } });
    created.splice(created.indexOf(serviceId), 1);
    expect(await prisma.chunk.count({ where: { serviceId } })).toBe(0);
  });
});

describe('backfill filename dates', () => {
  it('reads a date out of a filename', () => {
    expect(dateFromFilename('sermon-2026-08-16.mp4')).toBe('2026-08-16');
    expect(dateFromFilename('/archive/2019-01-06 morning.mkv')).toBe('2019-01-06');
  });

  it('returns nothing when there is no date, rather than guessing', () => {
    expect(dateFromFilename('sermon.mp4')).toBeUndefined();
    expect(dateFromFilename('clip-123.mp4')).toBeUndefined();
  });

  it('rejects an impossible date rather than letting it roll over', () => {
    expect(dateFromFilename('sermon-2026-02-31.mp4')).toBeUndefined();
    expect(dateFromFilename('sermon-2026-13-01.mp4')).toBeUndefined();
  });
});

describeDb('backfill runner', () => {
  let prisma: PrismaClient;
  let dir = '';

  beforeAll(async () => {
    prisma = createPrisma(DATABASE_URL as string);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const CONFIG = parseConfig({ soniox: { sourceLanguages: ['gu', 'en'], targetLanguage: 'en' } });

  it('finds video files and ignores everything else', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sermon-backfill-'));
    await writeFile(join(dir, 'a-2026-01-04.mp4'), '');
    await writeFile(join(dir, 'b-2026-01-11.mkv'), '');
    await writeFile(join(dir, 'notes.txt'), '');
    const found = await findVideos(dir);
    expect(found.map((f) => f.split('/').pop())).toEqual(['a-2026-01-04.mp4', 'b-2026-01-11.mkv']);
  });

  it('records a failure and keeps going, leaving resumable state', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sermon-backfill-'));
    // No date in the name and no --date: fails without touching the network.
    await writeFile(join(dir, 'undated.mp4'), '');
    await writeFile(join(dir, 'also-undated.mp4'), '');

    const results = await backfill({ dir, speaker: 'Swami Ji' }, CONFIG, prisma);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === 'failed')).toBe(true);

    // Second run skips them rather than retrying by default.
    const again = await backfill({ dir, speaker: 'Swami Ji' }, CONFIG, prisma);
    expect(again.every((r) => r.outcome === 'skipped')).toBe(true);
  });

  it('honours --limit, which is how the worst-recordings spike is run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sermon-backfill-'));
    for (const name of ['a-2026-01-04.mp4', 'b-2026-01-11.mp4', 'c-2026-01-18.mp4']) {
      await writeFile(join(dir, name), '');
    }
    const results = await backfill({ dir, speaker: 'Swami Ji', limit: 1 }, CONFIG, prisma);
    expect(results).toHaveLength(1);
  });

  it('honours --only for picking specific recordings', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sermon-backfill-'));
    await writeFile(join(dir, 'good-2026-01-04.mp4'), '');
    await writeFile(join(dir, 'worst-2026-01-11.mp4'), '');
    const results = await backfill({ dir, speaker: 'Swami Ji', only: 'worst' }, CONFIG, prisma);
    expect(results).toHaveLength(1);
    expect(results[0]?.file).toContain('worst');
  });
});
