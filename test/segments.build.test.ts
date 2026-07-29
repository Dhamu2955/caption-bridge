import { describe, expect, it } from 'vitest';

import {
  buildBlocks,
  buildSegments,
  enforceMinDuration,
  fillSpokenTiming,
  groupBlocks,
  joinTokens,
  mergeShortSegments,
  resolveOverlaps,
  separateTokens,
  splitOversizedBlocks,
} from '../src/segments/build.js';
import type { SonioxToken } from '../src/soniox/types.js';
import { OPTIONS, block, spoken, translated } from './helpers.js';

describe('token separation', () => {
  it('routes original, none and untagged tokens to the spoken stream', () => {
    const tokens: SonioxToken[] = [
      { text: 'a', start_ms: 0, end_ms: 100, translation_status: 'original' },
      { text: 'b', start_ms: 100, end_ms: 200, translation_status: 'none' },
      { text: 'c', start_ms: 200, end_ms: 300 },
      { text: 'X', translation_status: 'translation' },
    ];
    const { spoken: src, translated: dst } = separateTokens(tokens);
    expect(src.map((t) => t.text)).toEqual(['a', 'b', 'c']);
    expect(dst.map((t) => t.text)).toEqual(['X']);
  });

  it('drops empty and control tokens but KEEPS whitespace, which is a word separator', () => {
    const { spoken: src } = separateTokens([
      spoken('hello', 0, 500),
      { text: ' ', start_ms: 500, end_ms: 600, translation_status: 'original' },
      { text: '', start_ms: 600, end_ms: 600, translation_status: 'original' },
      { text: '<end>', start_ms: 600, end_ms: 600, translation_status: 'original' },
      spoken('world', 700, 1200),
    ]);
    expect(src.map((t) => t.text)).toEqual(['hello', ' ', 'world']);
    // Discarding the separator would have fused these into "helloworld".
    expect(joinTokens(src)).toBe('hello world');
  });

  it('concatenates sub-word tokens without inserting separators', () => {
    // Soniox emits sub-word pieces; a leading space is the ONLY word delimiter.
    // Adding one between pieces that lack it shatters every word.
    expect(joinTokens([{ text: 'અ' }, { text: 'ક્ષ' }, { text: 'ર' }])).toBe('અક્ષર');
    expect(joinTokens([{ text: 'The' }, { text: ' l' }, { text: 'ord' }, { text: ' of' }])).toBe(
      'The lord of',
    );
    expect(
      joinTokens([{ text: 'આ' }, { text: 'જે' }, { text: ' આ' }, { text: 'પ' }, { text: 'ણે' }]),
    ).toBe('આજે આપણે');
    expect(joinTokens([{ text: ' ser' }, { text: 'vice' }, { text: '.' }])).toBe('service.');
  });
});

describe('timestamp inheritance', () => {
  it('gives the translation the span of the spoken run it followed', () => {
    const blocks = buildBlocks([
      spoken('આજે', 1000, 1500),
      spoken(' વાત', 1500, 2400),
      translated('Today'),
      translated(' we talk'),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.original).toBe('આજે વાત');
    expect(blocks[0]?.translation).toBe('Today we talk');
    expect(blocks[0]?.startMs).toBe(1000);
    expect(blocks[0]?.endMs).toBe(2400);
    expect(blocks[0]?.translated).toBe(true);
  });

  it('pairs run-to-run, not token-to-token, when the counts differ', () => {
    // 4 spoken tokens, 2 translated. They are not 1-to-1 and must not be zipped.
    const blocks = buildBlocks([
      spoken('એક', 0, 400),
      spoken('બે', 400, 800),
      spoken('ત્રણ', 800, 1200),
      spoken('ચાર', 1200, 1600),
      translated('one'),
      translated(' four'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startMs).toBe(0);
    expect(blocks[0]?.endMs).toBe(1600);
    expect(blocks[0]?.translation).toBe('one four');
  });

  it('keeps separate runs separate and times each from its own spoken tokens', () => {
    const blocks = buildBlocks([
      spoken('એક', 0, 500),
      translated('one'),
      spoken('બે', 2000, 2600),
      translated('two'),
    ]);
    expect(blocks).toHaveLength(2);
    expect([blocks[0]?.startMs, blocks[0]?.endMs]).toEqual([0, 500]);
    expect([blocks[1]?.startMs, blocks[1]?.endMs]).toEqual([2000, 2600]);
  });

  it('falls back to the spoken text when no translation was emitted', () => {
    const blocks = buildBlocks([spoken('Already in English', 0, 2000)]);
    expect(blocks[0]?.translated).toBe(false);
    expect(blocks[0]?.translation).toBe('Already in English');
    expect(blocks[0]?.original).toBe('Already in English');
  });

  it('carries the previous end forward when a spoken token has no start', () => {
    const filled = fillSpokenTiming([
      spoken('a', 0, 500),
      { text: 'b', translation_status: 'original' },
      spoken('c', 900, 1400),
    ]);
    expect(filled[1]?.start_ms).toBe(500);
    expect(filled[1]?.end_ms).toBe(500);
  });

  it('never assigns timing to a translated token', () => {
    const filled = fillSpokenTiming([spoken('a', 0, 500), translated('A')]);
    expect(filled[1]?.start_ms).toBeUndefined();
    expect(filled[1]?.end_ms).toBeUndefined();
  });

  it('ignores the zero timestamps the API actually puts on translated tokens', () => {
    // stt-async-v5 sends start_ms/end_ms of 0 on every translated token. Taking
    // them at face value would drag every cue back to 00:00:00.
    const blocks = buildBlocks([
      spoken('ભ', 40_000, 40_500),
      spoken('ક્તિ', 40_500, 41_800),
      { text: 'Devotion', start_ms: 0, end_ms: 0, translation_status: 'translation' },
      { text: '.', start_ms: 0, end_ms: 0, translation_status: 'translation' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startMs).toBe(40_000);
    expect(blocks[0]?.endMs).toBe(41_800);
    expect(blocks[0]?.translation).toBe('Devotion.');
  });

  it('attaches a trailing orphan translation run rather than losing the text', () => {
    const blocks = buildBlocks([spoken('એક', 0, 500), translated('one'), translated(' more')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.translation).toBe('one more');
  });

  it('splits blocks on a speaker change', () => {
    const blocks = buildBlocks([
      spoken('એક', 0, 500, 1),
      translated('one', 1),
      spoken('બે', 500, 1000, 2),
      translated('two', 2),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.speaker).toBe('1');
    expect(blocks[1]?.speaker).toBe('2');
  });
});

describe('segment boundaries', () => {
  it('breaks after sentence-final punctuation', () => {
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 2000, original: 'First one.', endsSentence: true }),
        block({ startMs: 2100, endMs: 4000, original: 'Second one.', endsSentence: true }),
      ],
      OPTIONS,
    );
    expect(segments).toHaveLength(2);
  });

  it('breaks on a pause at or over the threshold', () => {
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 2000, original: 'a' }),
        block({ startMs: 2000 + OPTIONS.pauseMs, endMs: 6000, original: 'b' }),
      ],
      OPTIONS,
    );
    expect(segments).toHaveLength(2);
  });

  it('rides over a pause under the threshold — speakers pause mid-sentence', () => {
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 2000, original: 'a' }),
        block({ startMs: 2000 + OPTIONS.pauseMs - 1, endMs: 6000, original: 'b' }),
      ],
      OPTIONS,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.original).toBe('a b');
  });

  it('breaks on a speaker change even mid-sentence', () => {
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 2000, original: 'a', speaker: '1' }),
        block({ startMs: 2050, endMs: 4000, original: 'b', speaker: '2' }),
      ],
      OPTIONS,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.speaker).toBe('1');
    expect(segments[1]?.speaker).toBe('2');
  });

  it('breaks before a block that would push the cue past maxChars', () => {
    // 50 + 1 + 50 = 101 fits; adding a third would reach 152 and must not.
    const fifty = 'x'.repeat(50);
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 2000, original: fifty, translation: fifty }),
        block({ startMs: 2050, endMs: 4000, original: fifty, translation: fifty }),
        block({ startMs: 4050, endMs: 6000, original: fifty, translation: fifty }),
      ],
      OPTIONS,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.translation.length).toBe(101);
    expect(segments[1]?.translation.length).toBe(50);
    for (const segment of segments) {
      expect(segment.translation.length).toBeLessThanOrEqual(OPTIONS.maxChars);
    }
  });

  it('gives a block that alone exceeds maxChars its own cue', () => {
    const long = 'y'.repeat(200);
    const segments = groupBlocks(
      [block({ startMs: 0, endMs: 3000, original: long, translation: long, spokenTokens: [] })],
      OPTIONS,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.translation.length).toBe(200);
  });

  it('breaks before a block that would push the cue past maxSegmentMs', () => {
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 3000, original: 'a' }),
        block({ startMs: 3050, endMs: 6000, original: 'b' }),
        block({ startMs: 6050, endMs: 9000, original: 'c' }),
      ],
      OPTIONS,
    );
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(OPTIONS.maxSegmentMs);
    }
  });

  it('never ends a cue mid-word, even when the pause rule says to break', () => {
    // A hyphenated compound gets split across two blocks; breaking between them
    // would strand "-શ્રવણનો" at the start of the next caption.
    const segments = groupBlocks(
      [
        block({ startMs: 0, endMs: 2000, original: 'આ દર્શન', translation: 'this darshan' }),
        block({
          startMs: 4000,
          endMs: 6000,
          original: '-શ્રવણનો લાભ',
          translation: '-listen benefit',
          continuesWord: true,
          translationContinuesWord: true,
        }),
      ],
      OPTIONS,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.original).toBe('આ દર્શન-શ્રવણનો લાભ');
    expect(segments[0]?.translation).toBe('this darshan-listen benefit');
  });

  it('splits an oversized untranslated block on its own token timing', () => {
    const tokens = Array.from({ length: 40 }, (_, i) => spoken(` word${i}`, i * 500, i * 500 + 480));
    const blocks = splitOversizedBlocks(buildBlocks(tokens), OPTIONS);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(b.endMs - b.startMs).toBeLessThanOrEqual(OPTIONS.maxSegmentMs);
    }
    // No text is lost in the split.
    expect(blocks.map((b) => b.original).join(' ')).toBe(
      tokens.map((t) => t.text.trim()).join(' '),
    );
  });
});

describe('minimum-duration merging (INVARIANT 4)', () => {
  const short = (startMs: number, endMs: number, text: string) => ({
    index: 0,
    startMs,
    endMs,
    original: text,
    translation: text,
    speaker: undefined,
  });

  it('merges a short cue forward into the next one', () => {
    const merged = mergeShortSegments([short(0, 900, 'a'), short(900, 4000, 'b')], 1500);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.startMs).toBe(0);
    expect(merged[0]?.endMs).toBe(4000);
    expect(merged[0]?.translation).toBe('a b');
  });

  it('cascades until the result clears the floor', () => {
    const merged = mergeShortSegments(
      [short(0, 500, 'a'), short(500, 1000, 'b'), short(1000, 1400, 'c'), short(1400, 5000, 'd')],
      1500,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.translation).toBe('a b c d');
  });

  it('merges backwards when a short cue is last', () => {
    const merged = mergeShortSegments([short(0, 3000, 'a'), short(3000, 3400, 'b')], 1500);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.endMs).toBe(3400);
  });

  it('renumbers after merging', () => {
    const merged = mergeShortSegments(
      [short(0, 900, 'a'), short(900, 4000, 'b'), short(4000, 8000, 'c')],
      1500,
    );
    expect(merged.map((s) => s.index)).toEqual([0, 1]);
  });

  it('lets a merged cue exceed maxChars — the invariant outranks the char cap', () => {
    const long = 'y'.repeat(100);
    const merged = mergeShortSegments([short(0, 900, long), short(900, 4000, long)], 1500);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.translation.length).toBeGreaterThan(OPTIONS.maxChars);
  });

  it('extends a lone short cue, the one case with nothing to merge into', () => {
    const merged = enforceMinDuration(mergeShortSegments([short(0, 400, 'a')], 1500), 1500);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.endMs).toBe(1500);
  });

  it('produces no cue under the floor for a realistic stream of fast clauses', () => {
    const tokens: SonioxToken[] = [];
    for (let i = 0; i < 30; i++) {
      const start = i * 800;
      tokens.push(spoken(`શબ્દ${i}.`, start, start + 400));
      tokens.push(translated(`Word ${i}.`));
    }
    const segments = buildSegments(tokens, OPTIONS);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeGreaterThanOrEqual(OPTIONS.minDisplayMs);
    }
  });

  it('holds the floor across pauses, speaker changes and long clauses together', () => {
    const tokens: SonioxToken[] = [];
    let clock = 0;
    for (let i = 0; i < 40; i++) {
      const speaker = i % 7 === 0 ? 2 : 1;
      const duration = [200, 450, 1800, 300, 5200][i % 5] as number;
      tokens.push(spoken(`ગુ${i}${i % 3 === 0 ? '.' : ''}`, clock, clock + duration, speaker));
      tokens.push(translated(`En${i}${i % 3 === 0 ? '.' : ''}`, speaker));
      clock += duration + ([50, 900, 1500, 3000][i % 4] as number);
    }
    const segments = buildSegments(tokens, OPTIONS);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeGreaterThanOrEqual(OPTIONS.minDisplayMs);
    }
  });
});

describe('overlaps', () => {
  it('clamps a cue that runs into the next one', () => {
    const resolved = resolveOverlaps(
      [
        { index: 0, startMs: 0, endMs: 5000, original: 'a', translation: 'a', speaker: undefined },
        { index: 1, startMs: 3000, endMs: 8000, original: 'b', translation: 'b', speaker: undefined },
      ],
      1500,
    );
    expect(resolved[0]?.endMs).toBe(3000);
    expect(resolved[1]?.startMs).toBe(3000);
  });

  it('merges instead of clamping when clamping would breach the floor', () => {
    const resolved = resolveOverlaps(
      [
        { index: 0, startMs: 0, endMs: 5000, original: 'a', translation: 'a', speaker: undefined },
        { index: 1, startMs: 800, endMs: 6000, original: 'b', translation: 'b', speaker: undefined },
      ],
      1500,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.endMs).toBe(6000);
  });

  it('leaves no overlapping pair after a full build', () => {
    const tokens: SonioxToken[] = [];
    for (let i = 0; i < 25; i++) {
      tokens.push(spoken(`એ${i}.`, i * 700, i * 700 + 650));
      tokens.push(translated(`E${i}.`));
    }
    const segments = buildSegments(tokens, OPTIONS);
    for (let i = 0; i < segments.length - 1; i++) {
      expect(segments[i]!.endMs).toBeLessThanOrEqual(segments[i + 1]!.startMs);
    }
  });
});

describe('determinism', () => {
  it('produces identical segments for identical input', () => {
    const tokens: SonioxToken[] = [];
    for (let i = 0; i < 20; i++) {
      tokens.push(spoken(`ગુ${i}`, i * 900, i * 900 + 700, i % 4 === 0 ? 2 : 1));
      tokens.push(translated(`En${i}`, i % 4 === 0 ? 2 : 1));
    }
    expect(JSON.stringify(buildSegments(tokens, OPTIONS))).toBe(
      JSON.stringify(buildSegments(tokens, OPTIONS)),
    );
  });

  it('returns nothing for an empty token stream', () => {
    expect(buildSegments([], OPTIONS)).toEqual([]);
  });
});
