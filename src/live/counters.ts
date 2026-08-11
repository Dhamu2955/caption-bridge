import type { QueueEvent } from './types.js';

/**
 * What the live path is actually doing, counted.
 *
 * In memory and per session on purpose. These describe a service in progress,
 * and the question they answer ("is this working right now?") stops being
 * interesting the moment the process ends.
 *
 * It used to count seven kinds of event: releases and their lateness, skips,
 * drops, corrections, rejected corrections. All of those measured a scheduler
 * holding lines back and a reviewer acting on them. With neither left, there
 * are two facts worth a number — how much has gone out, and how much silence
 * there has been — and a tile reading "0 missed" every week was telling nobody
 * anything.
 */

export interface LiveCounters {
  /** Lines that have gone to air. */
  lines: number;
  /** Times the audio went away, and for how long in total. */
  gaps: number;
  gapMs: number;
}

export class QueueCounters {
  private lines = 0;
  private gaps = 0;
  private gapMs = 0;

  record(event: QueueEvent): void {
    if (event.type === 'line') {
      this.lines++;
      return;
    }
    this.gaps++;
    this.gapMs += event.durationMs;
  }

  get snapshot(): LiveCounters {
    return { lines: this.lines, gaps: this.gaps, gapMs: this.gapMs };
  }

  /** A new session is a new service; last week's numbers would be a lie. */
  reset(): void {
    this.lines = 0;
    this.gaps = 0;
    this.gapMs = 0;
  }
}
