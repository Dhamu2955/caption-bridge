import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { defaultLanguages, publish, publishAll, sha256, trackName } from '../src/commands/publish.js';
import { YoutubeClient, YoutubeError } from '../src/youtube/client.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Postgres is not needed here: the routing decisions worth pinning — update vs
 * insert, adopt vs duplicate, upload vs skip — are all made in publish.ts, and a
 * small in-memory stand-in for the three tables it touches keeps them testable
 * on a machine with no database. The persistence round-trip itself is covered by
 * the DB-gated tests in db.persistence.test.ts.
 */

const CONFIG = parseConfig({
  soniox: { sourceLanguages: ['gu', 'en'], targetLanguage: 'en' },
  ingest: { maxLineChars: 42, maxLines: 2 },
});

interface StubRow {
  language: string;
  trackId: string;
  contentHash: string;
}

interface StubOptions {
  youtubeVideoId?: string | null;
  uploads?: StubRow[];
  segments?: number;
}

/** Just the four calls publish makes, nothing more. */
function stubPrisma(options: StubOptions = {}) {
  const service = {
    id: 'svc-1',
    videoPath: '/media/sermon-2026-08-16.mp4',
    trimStartMs: 0,
    youtubeVideoId: options.youtubeVideoId ?? null,
  };
  const uploads: StubRow[] = [...(options.uploads ?? [])];
  const segments = Array.from({ length: options.segments ?? 2 }, (_, index) => ({
    index,
    startMs: index * 3000,
    endMs: index * 3000 + 2500,
    original: `ગુજરાતી ${index}`,
    translation: `English line ${index}`,
    speaker: null,
    editedBy: 'soniox',
    editedAt: null,
    previousTranslation: null,
  }));

  const upserts: { language: string; trackId: string }[] = [];
  const serviceUpdates: Record<string, unknown>[] = [];

  const prisma = {
    service: {
      findUnique: async ({ where }: { where: { id?: string; videoPath?: string } }) => {
        if (where.id === service.id) return service;
        if (where.videoPath === service.videoPath) return service;
        return null;
      },
      findMany: async () => (service.youtubeVideoId ? [service] : []),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        serviceUpdates.push(data);
        Object.assign(service, data);
        return service;
      },
    },
    segment: { findMany: async () => segments },
    captionUpload: {
      findMany: async () => uploads,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { serviceId_language: { serviceId: string; language: string } };
        create: StubRow;
        update: Partial<StubRow>;
      }) => {
        const language = where.serviceId_language.language;
        const existing = uploads.find((row) => row.language === language);
        if (existing) Object.assign(existing, update);
        else uploads.push(create);
        upserts.push({ language, trackId: (update.trackId ?? create.trackId) as string });
        return create;
      },
    },
  } as unknown as PrismaClient;

  return { prisma, uploads, upserts, serviceUpdates, service };
}

interface ApiCall {
  op: 'list' | 'insert' | 'update';
  arg: string;
  srt?: string;
}

/** A YoutubeClient whose HTTP layer is replaced, so no real client internals run. */
function stubClient(tracks: { id: string; language: string; trackKind?: string }[] = []) {
  const calls: ApiCall[] = [];
  const api = {
    listCaptions: async (videoId: string) => {
      calls.push({ op: 'list', arg: videoId });
      return tracks.map((track) => ({
        id: track.id,
        snippet: { language: track.language, trackKind: track.trackKind ?? 'standard' },
      }));
    },
    insertCaption: async (videoId: string, language: string, _name: string, srt: string) => {
      calls.push({ op: 'insert', arg: `${videoId}:${language}`, srt });
      return { id: `new-${language}` };
    },
    updateCaption: async (trackId: string, srt: string) => {
      calls.push({ op: 'update', arg: trackId, srt });
      return { id: trackId };
    },
  } as unknown as YoutubeClient;

  return { api, calls };
}

describe('publish helpers', () => {
  it('publishes the translation and the source language, in that order', () => {
    expect(defaultLanguages(CONFIG)).toEqual(['en', 'gu']);
  });

  it('names tracks so the YouTube language menu reads properly', () => {
    expect(trackName('en')).toBe('English');
    expect(trackName('gu')).toBe('ગુજરાતી');
    expect(trackName('hi')).toBe('HI');
  });

  it('hashes the same text to the same digest, and different text differently', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('publish', () => {
  it('inserts both tracks the first time', async () => {
    const { prisma, upserts } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient();

    const result = await publish({ ref: 'svc-1' }, CONFIG, prisma, api);

    expect(calls.filter((call) => call.op === 'insert').map((call) => call.arg)).toEqual([
      'vid-1:en',
      'vid-1:gu',
    ]);
    expect(result.tracks.map((track) => track.action)).toEqual(['inserted', 'inserted']);
    expect(upserts.map((row) => row.trackId)).toEqual(['new-en', 'new-gu']);
  });

  it('uploads the English translation to the en track and Gujarati to gu', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient();

    await publish({ ref: 'svc-1' }, CONFIG, prisma, api);

    const english = calls.find((call) => call.arg === 'vid-1:en');
    const gujarati = calls.find((call) => call.arg === 'vid-1:gu');
    expect(english?.srt).toContain('English line 0');
    expect(gujarati?.srt).toContain('ગુજરાતી 0');
  });

  it('updates rather than inserting when a track id is already recorded', async () => {
    const { prisma } = stubPrisma({
      youtubeVideoId: 'vid-1',
      uploads: [{ language: 'en', trackId: 'track-en', contentHash: 'stale' }],
    });
    const { api, calls } = stubClient();

    const result = await publish({ ref: 'svc-1', languages: ['en'] }, CONFIG, prisma, api);

    // A second insert would leave viewers with two "English" options.
    expect(calls).toEqual([{ op: 'update', arg: 'track-en', srt: expect.any(String) }]);
    expect(result.tracks[0]?.action).toBe('updated');
  });

  it('does nothing at all when the content has not changed', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient();

    await publish({ ref: 'svc-1', languages: ['en'] }, CONFIG, prisma, api);
    const first = calls.length;
    await publish({ ref: 'svc-1', languages: ['en'] }, CONFIG, prisma, api);

    // The second run must be free: no request, no quota.
    expect(calls).toHaveLength(first);
  });

  it('re-uploads unchanged content when --force is given', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient();

    await publish({ ref: 'svc-1', languages: ['en'] }, CONFIG, prisma, api);
    await publish({ ref: 'svc-1', languages: ['en'], force: true }, CONFIG, prisma, api);

    expect(calls.at(-1)?.op).toBe('update');
  });

  it('adopts a track already on the video rather than duplicating it', async () => {
    const { prisma, upserts } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient([{ id: 'existing-en', language: 'en' }]);

    const result = await publish({ ref: 'svc-1', languages: ['en'] }, CONFIG, prisma, api);

    expect(result.tracks[0]?.action).toBe('adopted');
    expect(calls.map((call) => call.op)).toEqual(['list', 'update']);
    expect(upserts[0]?.trackId).toBe('existing-en');
  });

  it("ignores YouTube's own auto-captions when looking for a track to adopt", async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient([{ id: 'asr-en', language: 'en', trackKind: 'ASR' }]);

    const result = await publish({ ref: 'svc-1', languages: ['en'] }, CONFIG, prisma, api);

    // Adopting the ASR track would mean overwriting machine captions in place
    // instead of publishing our own.
    expect(result.tracks[0]?.action).toBe('inserted');
    expect(calls.some((call) => call.op === 'update')).toBe(false);
  });

  it('lists once per service, not once per language', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient();

    await publish({ ref: 'svc-1' }, CONFIG, prisma, api);

    expect(calls.filter((call) => call.op === 'list')).toHaveLength(1);
  });

  it('remembers the video id so later republishes need only the video path', async () => {
    const { prisma, serviceUpdates } = stubPrisma({ youtubeVideoId: null });
    const { api } = stubClient();

    await publish({ ref: 'svc-1', youtubeVideoId: 'vid-9' }, CONFIG, prisma, api);

    expect(serviceUpdates).toEqual([{ youtubeVideoId: 'vid-9' }]);
  });

  it('refuses when no video id is known, naming the flag that fixes it', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: null });
    const { api } = stubClient();

    await expect(publish({ ref: 'svc-1' }, CONFIG, prisma, api)).rejects.toThrow(/--youtube-id/);
  });

  it('refuses a service with no cues rather than uploading an empty track', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1', segments: 0 });
    const { api } = stubClient();

    await expect(publish({ ref: 'svc-1' }, CONFIG, prisma, api)).rejects.toThrow(/no cues/);
  });

  it('resolves a service by video path as well as by id', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api } = stubClient();

    const result = await publish(
      { ref: '/media/sermon-2026-08-16.mp4', languages: ['en'] },
      CONFIG,
      prisma,
      api,
    );

    expect(result.serviceId).toBe('svc-1');
  });

  describe('--dry-run', () => {
    it('makes no API calls and needs no client at all', async () => {
      const { prisma, upserts, serviceUpdates } = stubPrisma({ youtubeVideoId: 'vid-1' });

      const result = await publish({ ref: 'svc-1', dryRun: true }, CONFIG, prisma);

      expect(result.tracks.map((track) => track.action)).toEqual(['inserted', 'inserted']);
      expect(upserts).toEqual([]);
      expect(serviceUpdates).toEqual([]);
    });

    it('reports the quota the real run would spend', async () => {
      const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
      const result = await publish({ ref: 'svc-1', dryRun: true }, CONFIG, prisma);
      expect(result.quotaUnits).toBe(800);
    });
  });

  it('demands credentials for a real run', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    await expect(publish({ ref: 'svc-1' }, CONFIG, prisma)).rejects.toThrow(/--auth/);
  });
});

describe('publishAll', () => {
  it('stops before starting a service it cannot afford', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api, calls } = stubClient();

    const result = await publishAll({ budget: 100 }, CONFIG, prisma, api);

    // Worst case for one service is list + two inserts = 850, well over 100.
    expect(calls).toEqual([]);
    expect(result.stoppedOnQuota).toBe(true);
    expect(result.published).toBe(0);
    // The untouched service is still outstanding, and counted exactly once.
    expect(result.remaining).toBe(1);
  });

  it('leaves a service that hit the quota wall mid-run outstanding', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const api = {
      listCaptions: async () => [],
      insertCaption: async () => {
        throw new YoutubeError('quota gone', 403, 'quotaExceeded');
      },
      updateCaption: async () => ({ id: 'x' }),
    } as unknown as YoutubeClient;

    const result = await publishAll({ budget: 9000 }, CONFIG, prisma, api);

    expect(result.stoppedOnQuota).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.published).toBe(0);
  });

  it('publishes within a budget that covers a service', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api } = stubClient();

    const result = await publishAll({ budget: 9000 }, CONFIG, prisma, api);

    expect(result.published).toBe(1);
    expect(result.stoppedOnQuota).toBe(false);
    expect(result.quotaUnits).toBe(850);
  });

  it('counts an already-current service as skipped, not published', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: 'vid-1' });
    const { api } = stubClient();

    await publishAll({ budget: 9000 }, CONFIG, prisma, api);
    const second = await publishAll({ budget: 9000 }, CONFIG, prisma, api);

    expect(second.skipped).toBe(1);
    expect(second.published).toBe(0);
    expect(second.quotaUnits).toBe(0);
  });

  it('does nothing when no service carries a video id', async () => {
    const { prisma } = stubPrisma({ youtubeVideoId: null });
    const { api, calls } = stubClient();

    const result = await publishAll({}, CONFIG, prisma, api);

    expect(result.published).toBe(0);
    expect(calls).toEqual([]);
  });
});
