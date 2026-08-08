import type {
  CaptionLine,
  Clock,
  OutputAdapter,
  OutputConfig,
  QueueEvent,
  QueueListener,
} from '../types.js';
import { systemClock } from '../types.js';

/**
 * Multi-output caption scheduler.
 *
 * INVARIANT 7 — one session, many outputs, each with its own delay.
 * INVARIANT 9 — releaseAt = sessionEpoch + audioStartMs + delayMs. Never
 *   arrivalTime + delay, which accumulates jitter over a two-hour broadcast.
 * INVARIANT 10 — this owns the clock. The operator is advisory: releases never
 *   wait for them, a late drop is rejected rather than retroactively applied,
 *   and "no operator" behaves identically to "operator connected but idle".
 *
 * Driven by `tick(now)` rather than internal timers, so tests advance time
 * directly and never sleep. `start()` wires it to a real interval.
 */

interface Scheduled {
  line: CaptionLine;
  /** A reviewer's correction, applied at release. `line` keeps the machine text
   *  so the original stays recoverable — the same reason the database keeps
   *  previousTranslation on an edited segment. */
  editedLine: CaptionLine | undefined;
  releaseAt: number;
  dropped: boolean;
}

interface OutputState {
  config: OutputConfig;
  adapter: OutputAdapter;
  pending: Scheduled[];
  /** Ids already released. A released line is immutable and can never be
   *  re-shown, edited or retroactively dropped. */
  released: Set<string>;
  lastReleasedAt: number | undefined;
  held: boolean;
}

export interface CaptionQueueOptions {
  /** Wall-clock time corresponding to audio position 0. */
  sessionEpoch: number;
  clock?: Clock;
}

/**
 * Which outputs an operator action applies to.
 *
 * A single name is the common case, but it must be possible to name several:
 * the YouTube closed-caption output is registered under its own name while
 * carrying the `stream` output's schedule, so scoping a drop to `'stream'`
 * alone silently let dropped lines reach YouTube anyway.
 */
export type OutputScope = string | readonly string[];

function inScope(name: string, scope: OutputScope | undefined): boolean {
  if (scope === undefined) return true;
  return typeof scope === 'string' ? name === scope : scope.includes(name);
}

export class CaptionQueue {
  private readonly outputs = new Map<string, OutputState>();
  private readonly listeners = new Set<QueueListener>();
  private readonly clock: Clock;
  private readonly sessionEpoch: number;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(options: CaptionQueueOptions) {
    this.sessionEpoch = options.sessionEpoch;
    this.clock = options.clock ?? systemClock;
  }

  addOutput(config: OutputConfig, adapter: OutputAdapter): void {
    this.outputs.set(config.name, {
      config,
      adapter,
      pending: [],
      released: new Set(),
      lastReleasedAt: undefined,
      held: false,
    });
  }

  on(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** INVARIANT 9. Exposed so the scheduling rule is directly testable. */
  releaseAtFor(line: CaptionLine, output: OutputConfig): number {
    return this.sessionEpoch + line.audioStartMs + output.delayMs;
  }

  /** Queue a completed line for every output. */
  add(line: CaptionLine): void {
    for (const state of this.outputs.values()) {
      state.pending.push({
        line,
        editedLine: undefined,
        releaseAt: this.releaseAtFor(line, state.config),
        dropped: false,
      });
      state.pending.sort((a, b) => a.releaseAt - b.releaseAt);
    }
  }

  /**
   * Operator action. Advisory: rejected once the line has gone out, because
   * removing it then would mean un-burning pixels.
   */
  drop(lineId: string, by = 'operator', outputs?: OutputScope): void {
    for (const state of this.outputs.values()) {
      if (!inScope(state.config.name, outputs)) continue;

      if (state.released.has(lineId)) {
        this.emit({
          type: 'drop-rejected',
          output: state.config.name,
          lineId,
          reason: 'already-released',
        });
        continue;
      }

      const entry = state.pending.find((item) => item.line.id === lineId);
      if (!entry) {
        this.emit({
          type: 'drop-rejected',
          output: state.config.name,
          lineId,
          reason: 'unknown-line',
        });
        continue;
      }

      entry.dropped = true;
      this.emit({ type: 'dropped', output: state.config.name, lineId, by });
    }
  }

  /**
   * Correct a line before it goes out.
   *
   * The same advisory contract as `drop`, and for the same reason: once a line
   * has been released it is immutable (INVARIANT 4), so a correction that
   * arrives late is rejected rather than chasing text already on screen.
   *
   * `CaptionLine` is readonly by design, so this stores a replacement alongside
   * the original rather than mutating it. Nothing that has already been handed
   * to an adapter can be reached from here.
   */
  editLine(lineId: string, translation: string, by = 'operator', outputs?: OutputScope): void {
    for (const state of this.outputs.values()) {
      if (!inScope(state.config.name, outputs)) continue;

      if (state.released.has(lineId)) {
        this.emit({
          type: 'edit-rejected',
          output: state.config.name,
          lineId,
          reason: 'already-released',
        });
        continue;
      }

      const entry = state.pending.find((item) => item.line.id === lineId);
      if (!entry) {
        this.emit({
          type: 'edit-rejected',
          output: state.config.name,
          lineId,
          reason: 'unknown-line',
        });
        continue;
      }

      const current = entry.editedLine ?? entry.line;
      entry.editedLine = { ...entry.line, translation };
      this.emit({
        type: 'edited',
        output: state.config.name,
        lineId,
        by,
        previousTranslation: current.translation,
        translation,
      });
    }
  }

  /** Operator pause. Explicit only — a disconnect must never cause this. */
  hold(outputName?: string): void {
    for (const state of this.outputs.values()) {
      if (!outputName || state.config.name === outputName) state.held = true;
    }
  }

  resume(outputName?: string): void {
    for (const state of this.outputs.values()) {
      if (!outputName || state.config.name === outputName) state.held = false;
    }
  }

  /** Panic path: clear what is on screen and discard everything queued. */
  async clearAll(): Promise<void> {
    for (const state of this.outputs.values()) {
      state.pending.length = 0;
      await state.adapter.clear();
    }
  }

  gap(durationMs: number): void {
    this.emit({ type: 'gap', durationMs });
  }

  pendingCount(outputName: string): number {
    return this.outputs.get(outputName)?.pending.length ?? 0;
  }

  /** Advance the scheduler. Returns the number of lines released. */
  tick(now: number = this.clock.now()): number {
    let releases = 0;

    for (const state of this.outputs.values()) {
      // A held output keeps accruing lateness; anything that ages out past
      // lateSkipMs is skipped on resume rather than dumped on screen at once.
      const remaining: Scheduled[] = [];

      for (const entry of state.pending) {
        if (entry.dropped) continue;

        if (now < entry.releaseAt) {
          remaining.push(entry);
          continue;
        }

        const lateBy = now - entry.releaseAt;
        if (lateBy > state.config.lateSkipMs) {
          this.emit({ type: 'skipped', output: state.config.name, line: entry.line, lateByMs: lateBy });
          continue;
        }

        if (state.held) {
          remaining.push(entry);
          continue;
        }

        // INVARIANT 4 rule 3 — hold the floor by queueing, never by cutting
        // the line already on screen short.
        if (
          state.lastReleasedAt !== undefined &&
          now - state.lastReleasedAt < state.config.minDisplayMs
        ) {
          remaining.push(entry);
          continue;
        }

        // A reviewer's correction wins if one arrived in time; from here on the
        // line is released and nothing can touch it.
        const released = entry.editedLine ?? entry.line;
        void state.adapter.show(released);
        state.released.add(released.id);
        state.lastReleasedAt = now;
        releases++;
        this.emit({
          type: 'released',
          output: state.config.name,
          line: released,
          scheduledAt: entry.releaseAt,
          releasedAt: now,
        });
      }

      state.pending = remaining;
    }

    return releases;
  }

  start(intervalMs = 100): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async close(): Promise<void> {
    this.stop();
    for (const state of this.outputs.values()) {
      await state.adapter.close?.();
    }
  }
}
