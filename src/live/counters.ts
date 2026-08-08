import type { QueueEvent } from './types.js';

/**
 * What the live path is actually doing, counted.
 *
 * Every number here already existed as an event on the queue's own stream —
 * releases, skips, drops, corrections, audio gaps — and nothing was adding them
 * up. That is the whole of this file: subscribe, tally, and expose.
 *
 * In memory and per session on purpose. These describe a service in progress,
 * and the question they answer ("is this working right now?") stops being
 * interesting the moment the process ends.
 */

export interface LiveCounters {
  released: number;
  /** Missed their moment and were skipped rather than shown late. */
  skipped: number;
  dropped: number;
  edited: number;
  /** Reviewer decisions that arrived after the line had gone out. */
  rejected: number;
  /** Times the audio went away, and for how long in total. */
  gaps: number;
  gapMs: number;
  /** How late releases run, which is the health signal that matters. */
  meanLatenessMs: number;
  maxLatenessMs: number;
  byOutput: Record<string, number>;
}

export class QueueCounters {
  private released = 0;
  private skipped = 0;
  private dropped = 0;
  private edited = 0;
  private rejected = 0;
  private gaps = 0;
  private gapMs = 0;
  private latenessTotal = 0;
  private latenessCount = 0;
  private maxLateness = 0;
  private readonly byOutput = new Map<string, number>();

  record(event: QueueEvent): void {
    switch (event.type) {
      case 'released': {
        this.released++;
        this.byOutput.set(event.output, (this.byOutput.get(event.output) ?? 0) + 1);
        // A release is scheduled for an instant; how far past it we actually
        // got is the only real measure of whether the pipeline is keeping up.
        const late = event.releasedAt - event.scheduledAt;
        if (Number.isFinite(late)) {
          this.latenessTotal += late;
          this.latenessCount++;
          if (late > this.maxLateness) this.maxLateness = late;
        }
        break;
      }
      case 'skipped':
        this.skipped++;
        break;
      case 'dropped':
        this.dropped++;
        break;
      case 'edited':
        this.edited++;
        break;
      case 'drop-rejected':
      case 'edit-rejected':
        this.rejected++;
        break;
      case 'gap':
        this.gaps++;
        this.gapMs += event.durationMs;
        break;
    }
  }

  get snapshot(): LiveCounters {
    return {
      released: this.released,
      skipped: this.skipped,
      dropped: this.dropped,
      edited: this.edited,
      rejected: this.rejected,
      gaps: this.gaps,
      gapMs: this.gapMs,
      meanLatenessMs:
        this.latenessCount > 0 ? Math.round(this.latenessTotal / this.latenessCount) : 0,
      maxLatenessMs: this.maxLateness,
      byOutput: Object.fromEntries(this.byOutput),
    };
  }

  reset(): void {
    this.released = 0;
    this.skipped = 0;
    this.dropped = 0;
    this.edited = 0;
    this.rejected = 0;
    this.gaps = 0;
    this.gapMs = 0;
    this.latenessTotal = 0;
    this.latenessCount = 0;
    this.maxLateness = 0;
    this.byOutput.clear();
  }
}
