import { describe, expect, it } from 'vitest';

import { chunkSegments, deepLink, DEFAULT_CHUNK_OPTIONS } from '../src/search/chunk.js';
import { HashEmbedder, toVectorLiteral } from '../src/search/embedder.js';
import type { Segment } from '../src/segments/types.js';

/** A minute of speech as ~20 three-second cues. */
function segments(count: number, cueMs = 3000): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    startMs: i * cueMs,
    endMs: i * cueMs + cueMs - 100,
    original: `ગુજરાતી ${i}`,
    translation: `English sentence number ${i}.`,
    speaker: '1',
  }));
}

describe('chunking above segment level (§3)', () => {
  it('produces passages of roughly the target length, not single cues', () => {
    const chunks = chunkSegments(segments(120), DEFAULT_CHUNK_OPTIONS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.lastSegmentIndex).toBeGreaterThan(chunk.firstSegmentIndex);
      expect(chunk.endMs - chunk.startMs).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxMs);
    }
  });

  it('keeps the first segment start as the seek target', () => {
    const input = segments(60);
    const chunks = chunkSegments(input);
    for (const chunk of chunks) {
      expect(chunk.startMs).toBe(input[chunk.firstSegmentIndex]!.startMs);
    }
  });

  it('overlaps consecutive chunks so a split passage stays findable', () => {
    const chunks = chunkSegments(segments(120));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i + 1]!.firstSegmentIndex).toBeLessThanOrEqual(chunks[i]!.lastSegmentIndex);
    }
  });

  it('carries both languages into every chunk', () => {
    const chunk = chunkSegments(segments(40))[0]!;
    expect(chunk.original).toContain('ગુજરાતી');
    expect(chunk.translation).toContain('English sentence');
  });

  it('always makes progress and terminates on pathological input', () => {
    // Every cue longer than the hard cap.
    const huge = segments(10, 400_000);
    const chunks = chunkSegments(huge);
    expect(chunks).toHaveLength(10);
    expect(chunks.map((c) => c.firstSegmentIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('covers every segment', () => {
    const input = segments(97);
    const chunks = chunkSegments(input);
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let i = chunk.firstSegmentIndex; i <= chunk.lastSegmentIndex; i++) covered.add(i);
    }
    expect(covered.size).toBe(input.length);
  });

  it('handles an empty transcript and a single cue', () => {
    expect(chunkSegments([])).toEqual([]);
    expect(chunkSegments(segments(1))).toHaveLength(1);
  });
});

describe('deep links', () => {
  it('points at whole seconds from the chunk start (§3)', () => {
    expect(deepLink('/media/sermon.mp4', 754_300)).toBe('/media/sermon.mp4#t=754');
    expect(deepLink('/media/sermon.mp4', 0)).toBe('/media/sermon.mp4#t=0');
  });
});

describe('embedding plumbing', () => {
  it('formats vectors the way pgvector expects', () => {
    expect(toVectorLiteral([0.5, -0.25, 0])).toBe('[0.5,-0.25,0]');
  });

  it('replaces non-finite values rather than emitting invalid SQL', () => {
    expect(toVectorLiteral([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[0,0]');
  });

  it('the test embedder is deterministic and unit length', async () => {
    const embedder = new HashEmbedder(64);
    const [a] = await embedder.embedPassages(['devotion and service']);
    const [b] = await embedder.embedPassages(['devotion and service']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const norm = Math.sqrt(a!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});
