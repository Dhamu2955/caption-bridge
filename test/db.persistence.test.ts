import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPrisma } from '../src/db/client.js';
import {
  EditsWouldBeLostError,
  MACHINE_AUTHOR,
  editSegment,
  loadSegments,
  saveService,
  toServiceDate,
} from '../src/db/services.js';
import { toExportSegments } from '../src/commands/export.js';
import { parseConfig } from '../src/config.js';
import { exportSrt } from '../src/commands/export.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { Segment } from '../src/segments/types.js';
import { toSrt } from '../src/srt/format.js';

const DATABASE_URL = process.env['DATABASE_URL'];

/** These need a real Postgres. Skipped, not failed, when one is not running. */
const describeDb = DATABASE_URL ? describe : describe.skip;

const CONFIG = parseConfig({
  soniox: { sourceLanguages: ['gu', 'en'], targetLanguage: 'en' },
  ingest: { maxLineChars: 42, maxLines: 2 },
});

const seg = (index: number, startMs: number, endMs: number, gu: string, en: string): Segment => ({
  index,
  startMs,
  endMs,
  original: gu,
  translation: en,
  speaker: '1',
});

const SEGMENTS: Segment[] = [
  seg(0, 0, 3000, 'આજે આપણે વાત કરીશું.', 'Today we will talk.'),
  seg(1, 3200, 6000, 'ભક્તિ એ માર્ગ છે.', 'Devotion is the path.'),
  seg(2, 6200, 9000, 'જય સ્વામિનારાયણ.', 'Jai Swaminarayan.'),
];

describeDb('persistence', () => {
  let prisma: PrismaClient;
  let dir = '';
  const created: string[] = [];

  beforeAll(async () => {
    prisma = createPrisma(DATABASE_URL as string);
    dir = await mkdtemp(join(tmpdir(), 'sermon-captions-db-'));
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

  const videoPath = (name: string) => join(dir, `${name}.mp4`);

  async function save(name: string, segments = SEGMENTS, opts = {}) {
    const result = await saveService(
      prisma,
      { date: '2026-08-16', speaker: 'Swami Ji', videoPath: videoPath(name), durationMs: 9000 },
      segments,
      opts,
    );
    if (!created.includes(result.serviceId)) created.push(result.serviceId);
    return result;
  }

  it('stores a service and its segments', async () => {
    const { serviceId, created: isNew } = await save('a');
    expect(isNew).toBe(true);

    const rows = await loadSegments(prisma, serviceId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rows[0]?.translation).toBe('Today we will talk.');
  });

  it('attributes untouched segments to the machine, not to a person', async () => {
    const { serviceId } = await save('b');
    const rows = await loadSegments(prisma, serviceId);
    for (const row of rows) {
      expect(row.editedBy).toBe(MACHINE_AUTHOR);
      expect(row.editedAt).toBeNull();
      expect(row.previousTranslation).toBeNull();
    }
  });

  it('keeps the service date on the calendar day given, regardless of timezone', async () => {
    const { serviceId } = await save('c');
    const service = await prisma.service.findUnique({ where: { id: serviceId } });
    expect(service?.date.toISOString().slice(0, 10)).toBe('2026-08-16');
    expect(toServiceDate('2026-08-16').toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });

  it('records who edited, when, and what the text was before', async () => {
    const { serviceId } = await save('d');
    const result = await editSegment(prisma, serviceId, 1, 'Devotion is the way.');
    expect(result).toEqual({ before: 'Devotion is the path.', after: 'Devotion is the way.' });

    const rows = await loadSegments(prisma, serviceId);
    const edited = rows[1]!;
    expect(edited.translation).toBe('Devotion is the way.');
    expect(edited.editedBy).toBe('local');
    expect(edited.editedAt).toBeInstanceOf(Date);
    expect(edited.previousTranslation).toBe('Devotion is the path.');
    // Neighbours untouched.
    expect(rows[0]?.editedAt).toBeNull();
  });

  it('keeps the machine baseline when a segment is edited twice', async () => {
    const { serviceId } = await save('e');
    await editSegment(prisma, serviceId, 0, 'First correction.');
    await editSegment(prisma, serviceId, 0, 'Second correction.');

    const rows = await loadSegments(prisma, serviceId);
    expect(rows[0]?.translation).toBe('Second correction.');
    // NOT "First correction." — the original transcription must stay reachable.
    expect(rows[0]?.previousTranslation).toBe('Today we will talk.');
  });

  it('does not mark a no-op edit as an edit', async () => {
    const { serviceId } = await save('f');
    await editSegment(prisma, serviceId, 0, 'Today we will talk.');
    const rows = await loadSegments(prisma, serviceId);
    expect(rows[0]?.editedAt).toBeNull();
    expect(rows[0]?.editedBy).toBe(MACHINE_AUTHOR);
  });

  it('returns null for a cue that does not exist', async () => {
    const { serviceId } = await save('g');
    expect(await editSegment(prisma, serviceId, 99, 'nope')).toBeNull();
  });

  it('re-ingest replaces segments when nothing was edited', async () => {
    const { serviceId } = await save('h');
    const shorter = [seg(0, 0, 4000, 'એક.', 'One.')];
    const again = await saveService(
      prisma,
      { date: '2026-08-16', speaker: 'Swami Ji', videoPath: videoPath('h'), durationMs: 4000 },
      shorter,
    );
    expect(again.serviceId).toBe(serviceId);
    expect(again.created).toBe(false);
    expect(await loadSegments(prisma, serviceId)).toHaveLength(1);
  });

  it('refuses to discard human corrections on re-ingest', async () => {
    const { serviceId } = await save('i');
    await editSegment(prisma, serviceId, 0, 'Corrected by a person.');

    await expect(save('i')).rejects.toBeInstanceOf(EditsWouldBeLostError);
    // The correction survived the refusal.
    const rows = await loadSegments(prisma, serviceId);
    expect(rows[0]?.translation).toBe('Corrected by a person.');
  });

  it('discards corrections only when explicitly told to', async () => {
    const { serviceId } = await save('j');
    await editSegment(prisma, serviceId, 0, 'Corrected by a person.');

    const again = await save('j', SEGMENTS, { replaceEdited: true });
    expect(again.discardedEdits).toBe(1);
    const rows = await loadSegments(prisma, serviceId);
    expect(rows[0]?.translation).toBe('Today we will talk.');
    expect(rows[0]?.editedAt).toBeNull();
  });

  it('deletes segments with the service', async () => {
    const { serviceId } = await save('k');
    await prisma.service.delete({ where: { id: serviceId } });
    created.splice(created.indexOf(serviceId), 1);
    expect(await loadSegments(prisma, serviceId)).toHaveLength(0);
  });

  describe('export is SELECT → format', () => {
    it('regenerates the SRT from the database, correction included', async () => {
      const { serviceId } = await save('export-a');
      await editSegment(prisma, serviceId, 1, 'Devotion is the way.');

      const result = await exportSrt({ ref: videoPath('export-a') }, CONFIG, prisma);
      expect(result.serviceId).toBe(serviceId);
      expect(result.cues).toBe(3);
      expect(result.editedCues).toBe(1);

      const srt = await readFile(result.targetSrt, 'utf8');
      expect(srt).toContain('Devotion is the way.');
      expect(srt).not.toContain('Devotion is the path.');
      expect(srt).toBe(
        '1\n00:00:00,000 --> 00:00:03,000\nToday we will talk.\n' +
          '\n2\n00:00:03,200 --> 00:00:06,000\nDevotion is the way.\n' +
          '\n3\n00:00:06,200 --> 00:00:09,000\nJai Swaminarayan.\n',
      );
    });

    it('finds a service by id as well as by video path', async () => {
      const { serviceId } = await save('export-b');
      const result = await exportSrt({ ref: serviceId }, CONFIG, prisma);
      expect(result.cues).toBe(3);
    });

    it('fails clearly for an unknown reference', async () => {
      await expect(exportSrt({ ref: '/nope/missing.mp4' }, CONFIG, prisma)).rejects.toThrow(
        /no service found/,
      );
    });
  });
});

/** Pure, so it runs with or without a database. */
describe('trimStartMs is applied at export (INVARIANT 1)', () => {
  const rows = [
    {
      index: 0,
      startMs: 65_000,
      endMs: 68_000,
      original: 'ગુ',
      translation: 'En',
      speaker: null,
      editedBy: 'soniox',
      editedAt: null,
      previousTranslation: null,
    },
  ];

  it('is a no-op on the happy path, where the video was trimmed first', () => {
    expect(toExportSegments(rows, 0)[0]?.startMs).toBe(65_000);
  });

  it('subtracts the offset for an untrimmed file', () => {
    const shifted = toExportSegments(rows, 60_000);
    expect(shifted[0]?.startMs).toBe(5000);
    expect(shifted[0]?.endMs).toBe(8000);
    expect(toSrt(shifted, 'translation', { maxLineChars: 42, maxLines: 2 })).toContain(
      '00:00:05,000 --> 00:00:08,000',
    );
  });

  it('never produces a negative timestamp', () => {
    expect(toExportSegments(rows, 999_999)[0]?.startMs).toBe(0);
  });
});
