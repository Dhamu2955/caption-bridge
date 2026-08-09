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
  /**
   * How long to keep holding speech whose translation has not arrived.
   *
   * Past this the line goes out untranslated, because a caption in the wrong
   * language beats no caption at all. Generous on purpose: it is the last
   * resort, not the normal path.
   */
  maxUntranslatedMs: number;
}

export const DEFAULT_LINE_OPTIONS: LineBuilderOptions = {
  pauseMs: 1200,
  maxChars: 138,
  maxSegmentMs: 7000,
  minDisplayMs: 1500,
  maxBufferMs: 8000,
  maxUntranslatedMs: 30_000,
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

    // Soniox delivers a run's translation before the endpoint that closes it,
    // so an endpoint flush always has everything it needs.
    if (sawEndpoint) return this.flush();

    if (this.bufferSpanMs() >= this.options.maxBufferMs) return this.flushTranslated();
    return [];
  }

  /**
   * Overflow flush: emit only speech whose translation has already arrived.
   *
   * The buffer fills faster than Soniox translates, so a speaker who runs past
   * `maxBufferMs` without an endpoint used to have their spoken tokens flushed
   * on their own. `buildSegments` finds no translation to pair them with and
   * falls back to the original — so the caption went out in Gujarati, and the
   * English arrived moments later into an emptied buffer and was dropped on the
   * floor. On a real sermon that was a third of the captions.
   *
   * So the trailing untranslated run stays buffered and leaves with its
   * translation next time. Only `maxUntranslatedMs` overrides that, because
   * waiting forever is its own failure.
   */
  private flushTranslated(): CaptionLine[] {
    const cut = this.lastCompletePairEnd();

    if (cut === 0) {
      // Nothing is translated yet. Hold, unless it has been far too long.
      if (this.bufferSpanMs() < this.options.maxUntranslatedMs) return [];
      return this.flush();
    }

    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return this.emit(ready);
  }

  /**
   * How much of the buffer is settled: everything before the first token that
   * is still waiting for a translation.
   *
   * The subtlety is `none`. A speaker saying "Please turn to page ten" inside a
   * Gujarati sentence gets those words back marked `none`, not `original` —
   * they are already in the target language, so Soniox never emits a
   * translation run for them. Waiting for one meant a code-switched aside sat
   * in the buffer until `maxUntranslatedMs`, and at 30s against a 15s assembly
   * delay `lateSkipMs` then dropped it outright. English the speaker actually
   * used, gone, with nothing to say why.
   *
   * So `none` is its own translation and settles immediately. Only `original`
   * with nothing translated after it holds the queue up.
   */
  private lastCompletePairEnd(): number {
    let lastTranslation = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i]!.translation_status === 'translation') lastTranslation = i;
    }
    for (let i = lastTranslation + 1; i < this.buffer.length; i++) {
      // Deliberately conservative: an untranslated run before a `none` one
      // keeps both back, because emitting out of order would put an English
      // aside on screen ahead of the sentence it interrupted.
      if (this.buffer[i]!.translation_status === 'original') return i;
    }
    return this.buffer.length;
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

  /** Emit whatever is buffered. Called on endpoint and at stream end. */
  flush(): CaptionLine[] {
    const tokens = this.buffer;
    this.buffer = [];
    return this.emit(tokens);
  }

  private emit(tokens: SonioxToken[]): CaptionLine[] {
    if (tokens.length === 0) return [];

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
