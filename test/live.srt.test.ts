import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LiveSrtWriter } from '../src/live/liveSrt.js';
import type { CaptionLine } from '../src/live/types.js';

const line = (translation: string, startMs: number, endMs: number): CaptionLine => ({
  id: `l-${startMs}`,
  original: 'ભક્તિ',
  translation,
  audioStartMs: startMs,
  audioEndMs: endMs,
  speaker: '1',
});

async function writer() {
  const dir = await mkdtemp(join(tmpdir(), 'live-srt-'));
  return new LiveSrtWriter(join(dir, 'out.srt'));
}

describe('subtitles written during a live service', () => {
  it('writes a valid cue per released line', async () => {
    const srt = await writer();
    srt.add(line('Devotion is the path.', 0, 2500));
    srt.add(line('It begins with listening.', 3000, 5500));

    expect(await readFile(srt.path, 'utf8')).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\nDevotion is the path.\n\n' +
      '2\n00:00:03,000 --> 00:00:05,500\nIt begins with listening.\n\n',
    );
  });

  it('never lets two cues overlap', async () => {
    // A correction released out of order would otherwise produce an SRT that
    // players render on top of itself.
    const srt = await writer();
    srt.add(line('First.', 0, 4000));
    srt.add(line('Second.', 1000, 5000));

    const text = await readFile(srt.path, 'utf8');
    expect(text).toContain('00:00:04,000 --> 00:00:05,000');
  });

  it('gives a cue a floor of half a second', async () => {
    const srt = await writer();
    srt.add(line('Short.', 1000, 1000));
    expect(await readFile(srt.path, 'utf8')).toContain('00:00:01,000 --> 00:00:01,500');
  });

  it('skips a line with nothing to show', async () => {
    const srt = await writer();
    srt.add(line('   ', 0, 2000));
    expect(srt.cues).toBe(0);
  });

  it('survives a directory it cannot write, rather than taking the service down', () => {
    // Subtitles are a by-product; the screens are the job.
    const srt = new LiveSrtWriter('/does/not/exist/anywhere/out.srt');
    expect(() => srt.add(line('Still broadcasting.', 0, 2000))).not.toThrow();
    expect(srt.cues).toBe(0);
  });

  it('names the file by LOCAL date and time, not UTC', () => {
    // A service starting just after midnight was filed under yesterday: the
    // stamp was UTC while the person looking for it was in the hall.
    const at = new Date(2026, 7, 16, 9, 30, 0);
    expect(LiveSrtWriter.pathFor('./recordings', at)).toBe(
      'recordings/live-2026-08-16-09-30-00.en.srt',
    );

    // 00:16 local is the previous day in UTC anywhere east of Greenwich.
    const afterMidnight = new Date(2026, 7, 12, 0, 16, 0);
    expect(LiveSrtWriter.pathFor('./recordings', afterMidnight)).toContain('2026-08-12');
  });
});
