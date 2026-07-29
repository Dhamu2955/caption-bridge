import type { SonioxToken } from '../soniox/types.js';

/**
 * A run of spoken tokens paired with the translated tokens that followed it.
 * This is the atom of the pipeline: the smallest unit whose timing is known
 * exactly, because it comes from the spoken side.
 */
export interface Block {
  original: string;
  translation: string;
  startMs: number;
  endMs: number;
  speaker: string | undefined;
  /** False when Soniox emitted no translation (already-English passage). */
  translated: boolean;
  /** Text ends in sentence-final punctuation — the primary boundary signal. */
  endsSentence: boolean;
  /** First token had no leading space, so this block continues the previous
   *  block's word. Tokens are sub-word pieces, so joining with a space here
   *  would split a word in half. */
  continuesWord: boolean;
  translationContinuesWord: boolean;
  /** Retained so an oversized block can be re-split on exact token timing. */
  spokenTokens: SonioxToken[];
  /** True when a block had to be split at an estimated point in the translation. */
  approximateSplit?: boolean;
}

/** One SRT cue. Mirrors the phase-2 `segment` table (§4) so import is trivial. */
export interface Segment {
  index: number;
  startMs: number;
  endMs: number;
  original: string;
  translation: string;
  speaker: string | undefined;
  approximateSplit?: boolean;
  /** Set only when a hard break landed mid-word — this cue's text continues
   *  the previous cue's final word. */
  continuesWord?: boolean;
}

export interface BuildOptions {
  pauseMs: number;
  maxChars: number;
  maxSegmentMs: number;
  minDisplayMs: number;
}
