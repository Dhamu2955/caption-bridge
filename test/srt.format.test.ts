import { describe, expect, it } from 'vitest';

import { formatTimecode, toSrt, wrapLines } from '../src/srt/format.js';
import type { Segment } from '../src/segments/types.js';

const segment = (
  index: number,
  startMs: number,
  endMs: number,
  original: string,
  translation: string,
): Segment => ({ index, startMs, endMs, original, translation, speaker: undefined });

describe('formatTimecode', () => {
  it('formats the boundaries correctly', () => {
    expect(formatTimecode(0)).toBe('00:00:00,000');
    expect(formatTimecode(1)).toBe('00:00:00,001');
    expect(formatTimecode(999)).toBe('00:00:00,999');
    expect(formatTimecode(1000)).toBe('00:00:01,000');
    expect(formatTimecode(59_999)).toBe('00:00:59,999');
    expect(formatTimecode(60_000)).toBe('00:01:00,000');
    expect(formatTimecode(3_599_999)).toBe('00:59:59,999');
    expect(formatTimecode(3_600_000)).toBe('01:00:00,000');
    expect(formatTimecode(3_661_001)).toBe('01:01:01,001');
  });

  it('handles a 90-minute sermon', () => {
    expect(formatTimecode(90 * 60_000)).toBe('01:30:00,000');
  });

  it('does not wrap past 99 hours', () => {
    expect(formatTimecode(100 * 3_600_000)).toBe('100:00:00,000');
  });

  it('clamps negatives and floors fractional milliseconds', () => {
    expect(formatTimecode(-1)).toBe('00:00:00,000');
    expect(formatTimecode(1500.9)).toBe('00:00:01,500');
    expect(formatTimecode(Number.NaN)).toBe('00:00:00,000');
  });
});

describe('wrapLines', () => {
  it('leaves a short line alone', () => {
    expect(wrapLines('Today we will talk.', 42, 2)).toBe('Today we will talk.');
  });

  it('breaks at the space nearest the middle', () => {
    const text = 'The teacher spoke about devotion and service to all people today';
    const wrapped = wrapLines(text, 42, 2);
    const lines = wrapped.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toBe(text);
    expect(Math.abs(lines[0]!.length - lines[1]!.length)).toBeLessThanOrEqual(8);
  });

  it('never produces a third line', () => {
    const text = 'word '.repeat(60).trim();
    expect(wrapLines(text, 42, 2).split('\n')).toHaveLength(2);
  });

  it('keeps an unbreakable string intact rather than dropping characters', () => {
    const text = 'x'.repeat(80);
    expect(wrapLines(text, 42, 2)).toBe(text);
  });

  it('collapses stray whitespace', () => {
    expect(wrapLines('  a   b  ', 42, 2)).toBe('a b');
  });
});

describe('toSrt', () => {
  const segments = [
    segment(0, 0, 2200, 'આજે આપણે વાત કરીશું.', 'Today we will talk.'),
    segment(1, 3600, 5600, 'ભગવાન કૃપા કરે.', 'May God bless you.'),
  ];

  it('emits numbered cues separated by a blank line', () => {
    expect(toSrt(segments, 'translation', { maxLineChars: 42, maxLines: 2 })).toBe(
      '1\n' +
        '00:00:00,000 --> 00:00:02,200\n' +
        'Today we will talk.\n' +
        '\n' +
        '2\n' +
        '00:00:03,600 --> 00:00:05,600\n' +
        'May God bless you.\n',
    );
  });

  it('emits the source track from the same segments, so the two files stay aligned', () => {
    const gu = toSrt(segments, 'original', { maxLineChars: 42, maxLines: 2 });
    const en = toSrt(segments, 'translation', { maxLineChars: 42, maxLines: 2 });
    expect(gu).toContain('આજે આપણે વાત કરીશું.');
    expect(gu.match(/-->/g)).toHaveLength(en.match(/-->/g)!.length);
  });

  it('numbers from 1 and skips empty text without leaving a gap', () => {
    const withEmpty = [
      segment(0, 0, 2000, 'a', 'A'),
      segment(1, 2000, 4000, 'b', '   '),
      segment(2, 4000, 6000, 'c', 'C'),
    ];
    const srt = toSrt(withEmpty, 'translation', { maxLineChars: 42, maxLines: 2 });
    expect(srt.match(/^\d+$/gm)).toEqual(['1', '2']);
  });

  it('never emits an end before its start', () => {
    const reversed = [segment(0, 5000, 1000, 'a', 'A')];
    expect(toSrt(reversed, 'translation', { maxLineChars: 42, maxLines: 2 })).toContain(
      '00:00:05,000 --> 00:00:05,000',
    );
  });

  it('returns an empty string for no segments', () => {
    expect(toSrt([], 'translation', { maxLineChars: 42, maxLines: 2 })).toBe('');
  });
});
