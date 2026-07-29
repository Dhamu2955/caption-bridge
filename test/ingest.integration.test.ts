import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRequest, ingest, outputPaths } from '../src/commands/ingest.js';
import { parseConfig } from '../src/config.js';
import { buildSegments } from '../src/segments/build.js';
import { toSrt } from '../src/srt/format.js';
import type { SonioxToken } from '../src/soniox/types.js';
import { OPTIONS } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/tokens.sermon.json', import.meta.url));

const CONFIG = parseConfig({
  soniox: {
    apiKeyEnv: 'SONIOX_API_KEY',
    model: 'stt-async-v5',
    sourceLanguages: ['gu', 'en'],
    targetLanguage: 'en',
    contextTerms: ['Swaminarayan', 'satsang'],
    translationTerms: [{ source: 'સેવા', target: 'seva' }],
  },
  ingest: { pauseMs: 1200, maxChars: 120, maxSegmentMs: 7000, minDisplayMs: 1500, maxLineChars: 42, maxLines: 2 },
});

async function fixtureTokens(): Promise<SonioxToken[]> {
  const parsed = JSON.parse(await readFile(FIXTURE, 'utf8')) as { tokens: SonioxToken[] };
  return parsed.tokens;
}

const EXPECTED_EN =
  '1\n00:00:00,000 --> 00:00:03,600\nToday we will speak about service.\n' +
  '\n2\n00:00:05,000 --> 00:00:07,200\nDevotion is the path.\n' +
  '\n3\n00:00:07,300 --> 00:00:09,000\nYes. Truly so.\n' +
  '\n4\n00:00:10,000 --> 00:00:12,500\nPlease turn to page ten.\n' +
  '\n5\n00:00:13,000 --> 00:00:14,800\nJai Swaminarayan.\n';

const EXPECTED_GU =
  '1\n00:00:00,000 --> 00:00:03,600\nઆજે આપણે સેવા વિશે વાત કરીશું.\n' +
  '\n2\n00:00:05,000 --> 00:00:07,200\nભક્તિ એ માર્ગ છે.\n' +
  '\n3\n00:00:07,300 --> 00:00:09,000\nહા. સાચે જ.\n' +
  '\n4\n00:00:10,000 --> 00:00:12,500\nPlease turn to page ten.\n' +
  '\n5\n00:00:13,000 --> 00:00:14,800\nજય સ્વામિનારાયણ.\n';

describe('fixture → SRT, byte for byte', () => {
  it('produces the expected English subtitles', async () => {
    const segments = buildSegments(await fixtureTokens(), OPTIONS);
    expect(toSrt(segments, 'translation', { maxLineChars: 42, maxLines: 2 })).toBe(EXPECTED_EN);
  });

  it('produces the expected source-language subtitles on the same timings', async () => {
    const segments = buildSegments(await fixtureTokens(), OPTIONS);
    // The English passage stays English in the .gu file — it is the source
    // track, not a guarantee of Gujarati.
    expect(toSrt(segments, 'original', { maxLineChars: 42, maxLines: 2 })).toBe(EXPECTED_GU);
  });

  it('honours INVARIANT 4 across the whole fixture', async () => {
    const segments = buildSegments(await fixtureTokens(), OPTIONS);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeGreaterThanOrEqual(1500);
    }
  });

  it('merged the 400ms clause rather than flashing it', async () => {
    const segments = buildSegments(await fixtureTokens(), OPTIONS);
    const merged = segments.find((s) => s.translation.startsWith('Yes.'));
    expect(merged?.translation).toBe('Yes. Truly so.');
    expect(merged!.endMs - merged!.startMs).toBe(1700);
  });
});

describe('request shape', () => {
  it('matches the Soniox async API', () => {
    expect(buildRequest(CONFIG, 'file-123')).toEqual({
      model: 'stt-async-v5',
      file_id: 'file-123',
      language_hints: ['gu', 'en'],
      enable_language_identification: true,
      enable_speaker_diarization: true,
      translation: { type: 'one_way', target_language: 'en' },
      context: {
        terms: ['Swaminarayan', 'satsang'],
        translation_terms: [{ source: 'સેવા', target: 'seva' }],
      },
    });
  });

  it('omits context entirely when nothing is configured', () => {
    const bare = parseConfig({ soniox: { sourceLanguages: ['gu', 'en'], targetLanguage: 'en' } });
    expect(buildRequest(bare, 'f')).not.toHaveProperty('context');
  });
});

describe('ingest writes files beside the video', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sermon-captions-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Seeds the transcript cache so the run needs no ffmpeg and no network. */
  async function seed(): Promise<string> {
    const videoPath = join(dir, 'sermon-2026-08-16.mp4');
    await writeFile(videoPath, '');
    const cache = {
      request: buildRequest(CONFIG, 'file-123'),
      transcription: { id: 'abc', model: 'stt-async-v5', audio_duration_ms: 15_000 },
      transcript: { id: 'abc', tokens: await fixtureTokens() },
    };
    await writeFile(join(dir, 'sermon-2026-08-16.soniox.json'), JSON.stringify(cache), 'utf8');
    return videoPath;
  }

  it('names outputs from the video basename and the configured languages', () => {
    const paths = outputPaths('/media/sermon-2026-08-16.mp4', CONFIG);
    expect(paths.targetSrt.endsWith('sermon-2026-08-16.en.srt')).toBe(true);
    expect(paths.sourceSrt.endsWith('sermon-2026-08-16.gu.srt')).toBe(true);
    expect(paths.segmentsJson.endsWith('sermon-2026-08-16.segments.json')).toBe(true);
  });

  it('writes both SRTs and the segments JSON', async () => {
    const videoPath = await seed();
    const result = await ingest(
      { videoPath, speaker: 'Swami Ji', date: '2026-08-16', force: false },
      CONFIG,
    );

    expect(result.cached).toBe(true);
    expect(await readFile(result.outputs.targetSrt, 'utf8')).toBe(EXPECTED_EN);
    expect(await readFile(result.outputs.sourceSrt, 'utf8')).toBe(EXPECTED_GU);

    const document = JSON.parse(await readFile(result.outputs.segmentsJson, 'utf8'));
    expect(document.speaker).toBe('Swami Ji');
    expect(document.date).toBe('2026-08-16');
    expect(document.video).toBe('sermon-2026-08-16.mp4');
    expect(document.durationMs).toBe(15_000);
    expect(document.segments).toHaveLength(5);
  });

  it('is idempotent — a second run produces byte-identical files', async () => {
    const videoPath = await seed();
    const args = { videoPath, speaker: 'Swami Ji', date: '2026-08-16', force: false };

    const first = await ingest(args, CONFIG);
    const before = await Promise.all([
      readFile(first.outputs.targetSrt, 'utf8'),
      readFile(first.outputs.sourceSrt, 'utf8'),
      readFile(first.outputs.segmentsJson, 'utf8'),
    ]);

    const second = await ingest(args, CONFIG);
    const after = await Promise.all([
      readFile(second.outputs.targetSrt, 'utf8'),
      readFile(second.outputs.sourceSrt, 'utf8'),
      readFile(second.outputs.segmentsJson, 'utf8'),
    ]);

    expect(after).toEqual(before);
  });

  it('rejects a missing video file', async () => {
    await expect(
      ingest({ videoPath: join(dir, 'nope.mp4'), speaker: 'x', date: '2026-08-16', force: false }, CONFIG),
    ).rejects.toThrow(/no such file/);
  });
});
