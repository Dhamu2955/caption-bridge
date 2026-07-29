import type { Segment } from '../segments/types.js';

/** Segments → SubRip. Pure and deterministic — same input, same bytes. */

export type SegmentField = 'original' | 'translation';

export interface SrtOptions {
  /** Soft wrap width. */
  maxLineChars: number;
  /** Hard cap on lines per cue. §4 says two; raise it only deliberately. */
  maxLines: number;
}

/** `HH:MM:SS,mmm`. Negatives clamp to zero; hours grow past 99 rather than wrap. */
export function formatTimecode(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const millis = total % 1000;
  const seconds = Math.floor(total / 1000) % 60;
  const minutes = Math.floor(total / 60_000) % 60;
  const hours = Math.floor(total / 3_600_000);
  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')},` +
    `${String(millis).padStart(3, '0')}`
  );
}

/**
 * Wrap into at most `maxLines` balanced lines.
 *
 * Lines are evened out rather than greedily filled, so a cue never ends with a
 * one-word orphan line. Never drops text: with no usable break point, or more
 * text than the line budget holds, the last line runs long instead.
 */
export function wrapLines(text: string, maxLineChars: number, maxLines: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const budget = Math.max(1, Math.floor(maxLines));
  if (clean === '' || clean.length <= maxLineChars || budget === 1) return clean;

  const words = clean.split(' ');
  if (words.length < 2) return clean;

  // Even out the lines: three lines of 40 read better than 42/42/16.
  const lineCount = Math.min(budget, Math.ceil(clean.length / maxLineChars));
  const target = Math.ceil(clean.length / lineCount);

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
      continue;
    }
    const isLastLine = lines.length === lineCount - 1;
    if (!isLastLine && current.length + 1 + word.length > target) {
      lines.push(current);
      current = word;
    } else {
      current += ` ${word}`;
    }
  }
  if (current !== '') lines.push(current);

  return lines.join('\n');
}

export function segmentText(segment: Segment, field: SegmentField): string {
  return (field === 'original' ? segment.original : segment.translation)
    .replace(/\s+/g, ' ')
    .trim();
}

export function toSrt(segments: Segment[], field: SegmentField, options: SrtOptions): string {
  const cues: string[] = [];
  let number = 0;

  for (const segment of segments) {
    const text = segmentText(segment, field);
    if (text === '') continue;
    number++;
    const start = formatTimecode(segment.startMs);
    const end = formatTimecode(Math.max(segment.endMs, segment.startMs));
    const body = wrapLines(text, options.maxLineChars, options.maxLines);
    cues.push(`${number}\n${start} --> ${end}\n${body}\n`);
  }

  return cues.length === 0 ? '' : `${cues.join('\n')}`;
}
