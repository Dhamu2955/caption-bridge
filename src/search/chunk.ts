import type { Segment } from '../segments/types.js';

/**
 * §3: chunk ABOVE segment level. A single cue is a clause — far too granular
 * to retrieve against. Passages of 1–3 minutes with overlap give the embedder
 * enough context, and the first segment's `startMs` is kept as the seek target
 * so a hit deep-links to where the passage begins, not to its middle.
 */

export interface ChunkOptions {
  /** Aim for this much speech per chunk. */
  targetMs: number;
  /** Never exceed this. */
  maxMs: number;
  /** Trailing context repeated into the next chunk, so a passage split down
   *  the middle is still retrievable from either side. */
  overlapMs: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetMs: 120_000,
  maxMs: 180_000,
  overlapMs: 30_000,
};

export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
  firstSegmentIndex: number;
  lastSegmentIndex: number;
  original: string;
  translation: string;
}

function join(segments: Segment[], field: 'original' | 'translation'): string {
  return segments
    .map((segment) => segment[field].trim())
    .filter((text) => text !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chunkSegments(
  segments: Segment[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  if (segments.length === 0) return [];

  const targetMs = Math.max(1, options.targetMs);
  const maxMs = Math.max(targetMs, options.maxMs);
  const overlapMs = Math.max(0, Math.min(options.overlapMs, targetMs - 1));

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < segments.length) {
    const first = segments[start];
    if (!first) break;
    const startMs = first.startMs;

    let end = start;
    while (end < segments.length - 1) {
      const next = segments[end + 1];
      const current = segments[end];
      if (!next || !current) break;
      // Stop before exceeding the hard cap...
      if (next.endMs - startMs > maxMs) break;
      // ...or once there is already enough speech in the chunk.
      if (current.endMs - startMs >= targetMs) break;
      end++;
    }

    const members = segments.slice(start, end + 1);
    const last = members[members.length - 1];
    if (!last) break;

    chunks.push({
      index: chunks.length,
      startMs,
      endMs: last.endMs,
      firstSegmentIndex: first.index,
      lastSegmentIndex: last.index,
      original: join(members, 'original'),
      translation: join(members, 'translation'),
    });

    if (end >= segments.length - 1) break;

    // Rewind by the overlap, but always make progress.
    const overlapFrom = last.endMs - overlapMs;
    let next = start + 1;
    while (next <= end) {
      const candidate = segments[next];
      if (!candidate || candidate.startMs >= overlapFrom) break;
      next++;
    }
    start = Math.min(Math.max(next, start + 1), end + 1);
  }

  return chunks;
}

/** §3: search hit → `video.mp4#t=<startMs/1000>`. */
export function deepLink(videoPath: string, startMs: number): string {
  return `${videoPath}#t=${Math.max(0, Math.floor(startMs / 1000))}`;
}
