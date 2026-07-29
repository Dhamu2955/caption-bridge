import { buildSegments } from '../../segments/build.js';
import type { BuildOptions } from '../../segments/types.js';
import type { SonioxToken } from '../../soniox/types.js';
import type { CaptionLine } from '../types.js';

/**
 * Streaming tokens → caption lines.
 *
 * Deliberately reuses `src/segments/build.ts` rather than reimplementing the
 * rules: §4 says the token parsing is shared with every phase, and a second
 * copy would drift from the one a year of async ingest has tuned.
 *
 * INVARIANT 4 rule 1: only final tokens ever reach a line. Non-final tokens
 * are surfaced separately for operator preview and never enter the buffer.
 */

export interface LineBuilderOptions extends BuildOptions {
  /** Flush without waiting for an endpoint once the buffer spans this long,
   *  so a speaker who never pauses still produces captions. */
  maxBufferMs: number;
}

export const DEFAULT_LINE_OPTIONS: LineBuilderOptions = {
  pauseMs: 1200,
  maxChars: 138,
  maxSegmentMs: 7000,
  minDisplayMs: 1500,
  maxBufferMs: 8000,
};

/** Soniox marks a detected endpoint with this token when the feature is on. */
const END_TOKEN = '<end>';

export class LineBuilder {
  private readonly options: LineBuilderOptions;
  private buffer: SonioxToken[] = [];
  private counter = 0;
  private preview = '';

  constructor(options: Partial<LineBuilderOptions> = {}) {
    this.options = { ...DEFAULT_LINE_OPTIONS, ...options };
  }

  /**
   * Feed one batch of tokens from the socket.
   * @returns lines that are complete and ready to schedule.
   */
  push(tokens: SonioxToken[]): CaptionLine[] {
    let sawEndpoint = false;
    const nonFinal: string[] = [];

    for (const token of tokens) {
      if (token.is_final !== true) {
        // Preview only. Never buffered, never displayed.
        if (typeof token.text === 'string') nonFinal.push(token.text);
        continue;
      }
      if (token.text?.trim() === END_TOKEN) {
        sawEndpoint = true;
        continue;
      }
      this.buffer.push(token);
    }

    this.preview = nonFinal.join('').replace(/\s+/g, ' ').trim();

    if (sawEndpoint) return this.flush();
    if (this.bufferSpanMs() >= this.options.maxBufferMs) return this.flush();
    return [];
  }

  /** Rolling non-final text, for the reviewer's early preview only (§4). */
  previewText(): string {
    return this.preview;
  }

  private bufferSpanMs(): number {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const token of this.buffer) {
      if (token.translation_status === 'translation') continue;
      if (Number.isFinite(token.start_ms)) min = Math.min(min, token.start_ms as number);
      if (Number.isFinite(token.end_ms)) max = Math.max(max, token.end_ms as number);
    }
    return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
  }

  /** Emit whatever is buffered. Called on endpoint, overflow, and at stream end. */
  flush(): CaptionLine[] {
    if (this.buffer.length === 0) return [];
    const tokens = this.buffer;
    this.buffer = [];

    return buildSegments(tokens, this.options).map((segment) => ({
      id: `line-${++this.counter}`,
      original: segment.original,
      translation: segment.translation,
      audioStartMs: segment.startMs,
      audioEndMs: segment.endMs,
      speaker: segment.speaker,
    }));
  }
}
