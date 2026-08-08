import { describe, expect, it } from 'vitest';

import { CaptionQueue } from '../src/live/pipeline/queue.js';
import { StubAdapter } from '../src/live/adapters/stub.js';
import type { CaptionLine, OutputConfig, QueueEvent } from '../src/live/types.js';

/**
 * INVARIANTS 4, 7, 9, 10. A fake clock throughout — §6 forbids setTimeout
 * sleeps here, and real timers would make these flaky anyway.
 */

const EPOCH = 1_000_000;

const line = (id: string, audioStartMs: number, text = id): CaptionLine => ({
  id,
  original: `gu-${text}`,
  translation: text,
  audioStartMs,
  audioEndMs: audioStartMs + 2000,
  speaker: '1',
});

const output = (name: string, delayMs: number, over: Partial<OutputConfig> = {}): OutputConfig => ({
  name,
  delayMs,
  reviewed: false,
  minDisplayMs: 1500,
  lateSkipMs: 2000,
  ...over,
});

function setup(configs: OutputConfig[]) {
  const queue = new CaptionQueue({ sessionEpoch: EPOCH });
  const adapters = new Map<string, StubAdapter>();
  const events: QueueEvent[] = [];
  queue.on((event) => events.push(event));
  for (const config of configs) {
    const adapter = new StubAdapter(config.name);
    adapters.set(config.name, adapter);
    queue.addOutput(config, adapter);
  }
  return { queue, adapters, events };
}

describe('INVARIANT 9 — schedule against audio timestamps', () => {
  it('releases at sessionEpoch + audioStartMs + delayMs', () => {
    const { queue } = setup([output('venue', 4000)]);
    expect(queue.releaseAtFor(line('a', 10_000), output('venue', 4000))).toBe(
      EPOCH + 10_000 + 4000,
    );
  });

  it('does not drift when a line arrives late', () => {
    const { queue, adapters } = setup([output('venue', 4000)]);
    const a = line('a', 10_000);
    // Added 3 seconds after it should have been scheduled — arrival time is
    // irrelevant, the release instant is fixed by the audio position.
    queue.add(a);
    queue.tick(EPOCH + 13_999);
    expect(adapters.get('venue')!.shown()).toEqual([]);
    queue.tick(EPOCH + 14_000);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);
  });

  it('holds each output to its own delay from one session (INVARIANT 7)', () => {
    const { queue, adapters } = setup([
      output('reviewer', 4000),
      output('venue', 4000),
      output('stream', 29_000, { reviewed: true }),
    ]);
    queue.add(line('a', 0));

    queue.tick(EPOCH + 4000);
    expect(adapters.get('reviewer')!.shown()).toEqual(['a']);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);
    expect(adapters.get('stream')!.shown()).toEqual([]);

    queue.tick(EPOCH + 29_000);
    expect(adapters.get('stream')!.shown()).toEqual(['a']);
  });
});

describe('INVARIANT 4 — pop-on discipline', () => {
  it('queues a fast follower rather than cutting the current line short', () => {
    const { queue, adapters } = setup([output('venue', 0)]);
    queue.add(line('a', 0));
    queue.add(line('b', 500)); // only 500ms later

    queue.tick(EPOCH + 0);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);

    queue.tick(EPOCH + 500);
    expect(adapters.get('venue')!.shown()).toEqual(['a']); // still held

    queue.tick(EPOCH + 1500);
    expect(adapters.get('venue')!.shown()).toEqual(['a', 'b']);
  });

  it('never re-shows or edits a line already released', () => {
    const { queue, adapters } = setup([output('venue', 0)]);
    queue.add(line('a', 0));
    queue.tick(EPOCH);
    queue.tick(EPOCH + 5000);
    queue.tick(EPOCH + 9000);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);
  });
});

describe('late release', () => {
  it('skips a line more than lateSkipMs overdue rather than desyncing', () => {
    const { queue, adapters, events } = setup([output('venue', 0, { lateSkipMs: 2000 })]);
    queue.add(line('a', 0));
    queue.tick(EPOCH + 2001);

    expect(adapters.get('venue')!.shown()).toEqual([]);
    const skipped = events.find((e) => e.type === 'skipped');
    expect(skipped).toMatchObject({ type: 'skipped', output: 'venue' });
    expect(queue.pendingCount('venue')).toBe(0);
  });

  it('still releases a line exactly at the lateness limit', () => {
    const { queue, adapters } = setup([output('venue', 0, { lateSkipMs: 2000 })]);
    queue.add(line('a', 0));
    queue.tick(EPOCH + 2000);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);
  });
});

describe('INVARIANT 10 — the scheduler owns the clock', () => {
  it('applies a drop received before the release deadline', () => {
    const { queue, adapters, events } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0));
    queue.drop('a', 'reviewer');
    queue.tick(EPOCH + 29_000);

    expect(adapters.get('stream')!.shown()).toEqual([]);
    expect(events.some((e) => e.type === 'dropped')).toBe(true);
  });

  it('rejects a drop that arrives after the line went out', () => {
    const { queue, adapters, events } = setup([output('venue', 0)]);
    queue.add(line('a', 0));
    queue.tick(EPOCH);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);

    queue.drop('a', 'reviewer');
    const rejected = events.find((e) => e.type === 'drop-rejected');
    expect(rejected).toMatchObject({ reason: 'already-released' });
    // Nothing retroactive happened.
    expect(adapters.get('venue')!.calls.filter((c) => c.action === 'clear')).toHaveLength(0);
  });

  it('reports a drop for a line it has never seen', () => {
    const { queue, events } = setup([output('venue', 0)]);
    queue.drop('ghost');
    expect(events.find((e) => e.type === 'drop-rejected')).toMatchObject({
      reason: 'unknown-line',
    });
  });

  it('produces identical output whether or not an operator is connected', () => {
    const idle = setup([output('venue', 4000)]);
    const absent = setup([output('venue', 4000)]);

    for (const context of [idle, absent]) {
      context.queue.add(line('a', 0));
      context.queue.add(line('b', 3000));
    }
    // Only difference: one "operator" is attached but takes no action.
    idle.queue.on(() => {});

    for (const now of [EPOCH, EPOCH + 4000, EPOCH + 7000, EPOCH + 9000]) {
      idle.queue.tick(now);
      absent.queue.tick(now);
    }
    expect(idle.adapters.get('venue')!.shown()).toEqual(absent.adapters.get('venue')!.shown());
  });

  it('a dropped line on one output does not affect another', () => {
    const { queue, adapters } = setup([output('venue', 0), output('stream', 29_000)]);
    queue.add(line('a', 0));
    queue.drop('a', 'reviewer', 'stream');

    queue.tick(EPOCH);
    queue.tick(EPOCH + 29_000);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);
    expect(adapters.get('stream')!.shown()).toEqual([]);
  });
});

describe('hold and resume', () => {
  it('holds releases while paused, then resumes', () => {
    const { queue, adapters } = setup([output('venue', 0, { lateSkipMs: 60_000 })]);
    queue.add(line('a', 0));
    queue.hold();
    queue.tick(EPOCH);
    expect(adapters.get('venue')!.shown()).toEqual([]);

    queue.resume();
    queue.tick(EPOCH + 100);
    expect(adapters.get('venue')!.shown()).toEqual(['a']);
  });

  it('skips lines that aged out during a long hold rather than dumping them', () => {
    const { queue, adapters } = setup([output('venue', 0, { lateSkipMs: 2000 })]);
    queue.add(line('a', 0));
    queue.add(line('b', 30_000));
    queue.hold();
    queue.tick(EPOCH + 10_000);
    queue.resume();
    queue.tick(EPOCH + 30_000);

    // 'a' was 30s overdue and is gone; 'b' is on time.
    expect(adapters.get('venue')!.shown()).toEqual(['b']);
  });

  it('clearAll empties the queue and wipes the screen', async () => {
    const { queue, adapters } = setup([output('venue', 0)]);
    queue.add(line('a', 0));
    await queue.clearAll();
    queue.tick(EPOCH + 1);
    expect(adapters.get('venue')!.shown()).toEqual([]);
    expect(adapters.get('venue')!.calls.some((c) => c.action === 'clear')).toBe(true);
  });
});

describe('gap reporting', () => {
  it('emits outage duration so a hole in the transcript is visible', () => {
    const { queue, events } = setup([output('venue', 0)]);
    queue.gap(4200);
    expect(events).toContainEqual({ type: 'gap', durationMs: 4200 });
  });
});

describe('editing a line before it is released (INVARIANT 4 rule 2)', () => {
  it('releases the corrected text when the edit arrives in time', () => {
    const { queue, adapters } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0, 'The lord of everything.'));

    queue.editLine('a', 'The Lord of all.', 'reviewer');
    queue.tick(EPOCH + 29_000);

    expect(adapters.get('stream')!.shown()).toEqual(['The Lord of all.']);
  });

  it('keeps the machine text recoverable in the event', () => {
    const { queue, events } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0, 'Machine wording.'));

    queue.editLine('a', 'Reviewer wording.', 'reviewer');

    expect(events.find((event) => event.type === 'edited')).toMatchObject({
      output: 'stream',
      lineId: 'a',
      by: 'reviewer',
      // NOT dropped — the JSONL is a labelled set of human-judged translations,
      // which needs both sides of the correction.
      previousTranslation: 'Machine wording.',
      translation: 'Reviewer wording.',
    });
  });

  it('does not touch the line already handed to the adapter', () => {
    const { queue, adapters, events } = setup([output('stream', 0)]);
    queue.add(line('a', 0, 'Went out as-is.'));
    queue.tick(EPOCH);

    queue.editLine('a', 'Too late.', 'reviewer');

    expect(adapters.get('stream')!.shown()).toEqual(['Went out as-is.']);
    expect(events.find((event) => event.type === 'edit-rejected')).toMatchObject({
      lineId: 'a',
      reason: 'already-released',
    });
  });

  it('rejects an edit for a line it has never seen', () => {
    const { queue, events } = setup([output('stream', 29_000)]);
    queue.editLine('ghost', 'anything', 'reviewer');
    expect(events.find((event) => event.type === 'edit-rejected')).toMatchObject({
      lineId: 'ghost',
      reason: 'unknown-line',
    });
  });

  it('applies only to the named output, leaving the venue copy alone', () => {
    const { queue, adapters } = setup([output('venue', 4000), output('stream', 29_000)]);
    queue.add(line('a', 0, 'Original.'));

    queue.editLine('a', 'Corrected.', 'reviewer', 'stream');
    queue.tick(EPOCH + 4000);
    queue.tick(EPOCH + 29_000);

    // The venue screen showed it 25 seconds ago; only the reviewed path can
    // still change.
    expect(adapters.get('venue')!.shown()).toEqual(['Original.']);
    expect(adapters.get('stream')!.shown()).toEqual(['Corrected.']);
  });

  it('takes the last correction when a reviewer edits twice', () => {
    const { queue, adapters, events } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0, 'First.'));

    queue.editLine('a', 'Second.', 'reviewer');
    queue.editLine('a', 'Third.', 'reviewer');
    queue.tick(EPOCH + 29_000);

    expect(adapters.get('stream')!.shown()).toEqual(['Third.']);
    const edits = events.filter((event) => event.type === 'edited');
    expect(edits.at(-1)).toMatchObject({ previousTranslation: 'Second.', translation: 'Third.' });
  });

  it('still drops a line that was edited — a correction is not an approval', () => {
    const { queue, adapters } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0, 'Original.'));

    queue.editLine('a', 'Corrected.', 'reviewer');
    queue.drop('a', 'reviewer');
    queue.tick(EPOCH + 29_000);

    expect(adapters.get('stream')!.shown()).toEqual([]);
  });

  it('leaves the Gujarati source untouched — only the translation is corrected', () => {
    const { queue, events } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0, 'English.'));

    queue.editLine('a', 'Better English.', 'reviewer');
    queue.tick(EPOCH + 29_000);

    const released = events.find((event) => event.type === 'released');
    expect(released).toMatchObject({ line: { original: 'gu-English.', id: 'a' } });
  });

  it('does not delay the release it corrects (INVARIANT 10)', () => {
    const { queue, adapters } = setup([output('stream', 29_000)]);
    queue.add(line('a', 0, 'Original.'));
    queue.editLine('a', 'Corrected.', 'reviewer');

    queue.tick(EPOCH + 28_999);
    expect(adapters.get('stream')!.shown()).toEqual([]);
    queue.tick(EPOCH + 29_000);
    expect(adapters.get('stream')!.shown()).toEqual(['Corrected.']);
  });

  it('gives the reviewer the whole window to act, however long it is', () => {
    // The point of a three-minute window: a correction sent at 2m59s still
    // lands, because nothing is released until the deadline.
    const { queue, adapters } = setup([output('stream', 184_000)]);
    queue.add(line('a', 0, 'Original.'));

    queue.tick(EPOCH + 100_000);
    queue.editLine('a', 'Corrected at the last moment.', 'reviewer');
    queue.tick(EPOCH + 184_000);

    expect(adapters.get('stream')!.shown()).toEqual(['Corrected at the last moment.']);
  });
});

describe('holding for longer than lateSkipMs', () => {
  it('discards what aged out rather than dumping it on screen at once', () => {
    const { queue, adapters, events } = setup([output('stream', 0, { lateSkipMs: 2000 })]);
    queue.add(line('a', 0));

    queue.hold();
    // A "pause captions" press held past lateSkipMs. The late-skip check sits
    // above the hold check in tick, so the line is skipped, not queued — a
    // desynced caption is worse than none. At a three-minute review window an
    // operator pause is far more likely to cross this threshold, so the
    // behaviour is pinned rather than left to be discovered on the night.
    queue.tick(EPOCH + 5000);
    queue.resume();
    queue.tick(EPOCH + 5001);

    expect(adapters.get('stream')!.shown()).toEqual([]);
    expect(events.find((event) => event.type === 'skipped')).toMatchObject({ lateByMs: 5000 });
  });

  it('releases normally when the hold is shorter than lateSkipMs', () => {
    const { queue, adapters } = setup([output('stream', 0, { lateSkipMs: 2000 })]);
    queue.add(line('a', 0));

    queue.hold();
    queue.tick(EPOCH + 1000);
    queue.resume();
    queue.tick(EPOCH + 1001);

    expect(adapters.get('stream')!.shown()).toEqual(['a']);
  });
});
