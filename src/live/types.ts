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
  /** Milliseconds from the session epoch, taken from the SPOKEN tokens.
   *  INVARIANT 9 schedules against this, never against arrival time. */
  readonly audioStartMs: number;
  readonly audioEndMs: number;
  readonly speaker: string | undefined;
}

export interface OutputConfig {
  readonly name: string;
  /** INVARIANT 7 — delay is per output. The reviewed path is delayA + delayB. */
  readonly delayMs: number;
  /** Whether an operator sits between assembly and air for this output. */
  readonly reviewed: boolean;
  /** INVARIANT 4 — no cue shorter than this; later lines queue rather than
   *  cutting this one short. */
  readonly minDisplayMs: number;
  /** Past this much lateness a line is skipped: a desynced caption is worse
   *  than no caption. */
  readonly lateSkipMs: number;
}

/**
 * INVARIANT 4 rule 1: non-final tokens never reach an audience-facing surface.
 * There is deliberately no flag to turn this off — a config option would be an
 * invitation to set it wrong on the night.
 */
export const INCLUDE_NON_FINAL = false as const;

export interface OutputAdapter {
  readonly name: string;
  show(line: CaptionLine): void | Promise<void>;
  clear(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type QueueEvent =
  | {
      type: 'released';
      output: string;
      line: CaptionLine;
      scheduledAt: number;
      releasedAt: number;
    }
  | { type: 'skipped'; output: string; line: CaptionLine; lateByMs: number }
  | { type: 'dropped'; output: string; lineId: string; by: string }
  | {
      type: 'drop-rejected';
      output: string;
      lineId: string;
      reason: 'already-released' | 'unknown-line';
    }
  | {
      type: 'edited';
      output: string;
      lineId: string;
      by: string;
      /** The text being replaced, kept for the same reason the database keeps
       *  previousTranslation: the machine baseline must stay recoverable. */
      previousTranslation: string;
      translation: string;
    }
  | {
      type: 'edit-rejected';
      output: string;
      lineId: string;
      reason: 'already-released' | 'unknown-line';
    }
  | { type: 'gap'; durationMs: number };

export type QueueListener = (event: QueueEvent) => void;

/** Wall clock, injectable so tests never sleep. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
