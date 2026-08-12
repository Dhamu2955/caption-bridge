/**
 * Live bridge types. Phase 5 — see SPEC §4 and INVARIANTS 4–10.
 *
 * The one rule everything here serves: a caption that has been RELEASED is
 * immutable. Nothing in this module offers a way to edit or withdraw a line
 * once it has gone to an output. A line still pending in the queue has been
 * shown to nobody, so correcting it is not an exception to that rule.
 */

export interface CaptionLine {
  readonly id: string;
  readonly original: string;
  readonly translation: string;
  /** Milliseconds from the session epoch, taken from the SPOKEN tokens —
   *  never from when they arrived. The .srt and the Google Doc both use it. */
  readonly audioStartMs: number;
  readonly audioEndMs: number;
  readonly speaker: string | undefined;
}

/**
 * INVARIANT 4 rule 1: non-final tokens never reach a pop-on output.
 *
 * This is still the default for every session and the line builder discards
 * non-final tokens whatever it is set to, so `venue`, `stream`, `overflow`, the
 * reviewer and the YouTube captions cannot show one by any route.
 *
 * It said "there is deliberately no flag to turn this off, a config option
 * would be an invitation to set it wrong on the night", and that reasoning
 * still holds for those outputs. What changed is that there is now a surface
 * whose entire purpose is rendering provisional text — the `raw` passthrough
 * overlay — so the flag exists for that one consumer rather than as a global
 * switch. Turning it on adds an output; it does not alter any existing one.
 */
export const INCLUDE_NON_FINAL = false as const;

export interface OutputAdapter {
  readonly name: string;
  show(line: CaptionLine): void | Promise<void>;
  clear(): void | Promise<void>;
  close?(): void | Promise<void>;
}

/**
 * What the live path did, for the counters on the Captions tab.
 *
 * Two cases, where there were seven. The other five — released, skipped,
 * dropped, edited and their rejections — described a scheduler holding lines
 * back and a reviewer acting on them, and neither exists any more. A line is
 * built and it goes out; there is no third state to report.
 */
export type QueueEvent =
  | { type: 'line'; line: CaptionLine }
  | { type: 'gap'; durationMs: number };

export type QueueListener = (event: QueueEvent) => void;

/** Wall clock, injectable so tests never sleep. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
