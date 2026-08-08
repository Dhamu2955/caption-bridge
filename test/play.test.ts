import { describe, expect, it } from 'vitest';

import { PlayDriver, findSegmentAt, toCaptionLine } from '../src/commands/play.js';
import { extractInputPosition } from '../src/live/adapters/vmix.js';
import { StubAdapter } from '../src/live/adapters/stub.js';
import type { Segment } from '../src/segments/types.js';

/**
 * Playback captions are position-driven, so the tests drive position directly
 * rather than time — the same discipline as the fake clock in live.queue.
 */

const segment = (index: number, startMs: number, endMs: number): Segment => ({
  index,
  startMs,
  endMs,
  original: `ગુજરાતી ${index}`,
  translation: `English ${index}`,
  speaker: undefined,
});

/** Cue 1 runs 0–2s, cue 2 4–6s (a two-second gap), cue 3 6–9s. */
const SEGMENTS = [segment(0, 0, 2000), segment(1, 4000, 6000), segment(2, 6000, 9000)];

const GUID = '8dd4a1cc-1f2f-4f1e-9a3e-2c0a0a1b2c3d';

function stateXml(attributes: string): string {
  return `<vmix><version>27</version><inputs>
<input key="other-guid" number="1" type="Colour" title="Background"/>
<input key="${GUID}" number="2" type="Video" title="sermon.mp4" ${attributes}/>
</inputs></vmix>`;
}

describe('finding the cue for a playback position', () => {
  it('finds the cue spanning the position', () => {
    expect(findSegmentAt(SEGMENTS, 1000)?.index).toBe(0);
    expect(findSegmentAt(SEGMENTS, 5000)?.index).toBe(1);
    expect(findSegmentAt(SEGMENTS, 7000)?.index).toBe(2);
  });

  it('includes the start of a cue and excludes its end', () => {
    // Half-open, so two adjacent cues can never both match one millisecond.
    expect(findSegmentAt(SEGMENTS, 0)?.index).toBe(0);
    expect(findSegmentAt(SEGMENTS, 1999)?.index).toBe(0);
    expect(findSegmentAt(SEGMENTS, 2000)).toBeUndefined();
    expect(findSegmentAt(SEGMENTS, 6000)?.index).toBe(2);
  });

  it('shows nothing in the silence between cues', () => {
    expect(findSegmentAt(SEGMENTS, 3000)).toBeUndefined();
  });

  it('shows nothing past the last cue or before the first', () => {
    expect(findSegmentAt(SEGMENTS, 9000)).toBeUndefined();
    expect(findSegmentAt(SEGMENTS, 999_999)).toBeUndefined();
  });

  it('handles a service with no cues rather than looping', () => {
    expect(findSegmentAt([], 1000)).toBeUndefined();
  });

  it('finds the same cue whichever direction the operator seeks', () => {
    // A backwards scrub is the case a clock-driven scheduler cannot serve.
    const forwards = findSegmentAt(SEGMENTS, 7000)?.index;
    const backwards = findSegmentAt(SEGMENTS, 1000)?.index;
    expect(forwards).toBe(2);
    expect(backwards).toBe(0);
  });

  it('carries both languages onto the caption line', () => {
    const line = toCaptionLine(SEGMENTS[1]!);
    expect(line).toMatchObject({
      id: 'cue-1',
      original: 'ગુજરાતી 1',
      translation: 'English 1',
      audioStartMs: 4000,
      audioEndMs: 6000,
    });
  });
});

describe('reading playback position from vMix state XML', () => {
  it('reads position, duration and state off the input', () => {
    const xml = stateXml('state="Running" position="12345" duration="3600000"');
    expect(extractInputPosition(xml, GUID)).toEqual({
      positionMs: 12_345,
      durationMs: 3_600_000,
      state: 'Running',
    });
  });

  it('reads a paused input, since a pause must hold the caption', () => {
    const xml = stateXml('state="Paused" position="5000" duration="9000"');
    expect(extractInputPosition(xml, GUID)?.state).toBe('Paused');
  });

  it('reads attributes in any order', () => {
    const xml = `<vmix><inputs><input position="700" key="${GUID}" state="Running"/></inputs></vmix>`;
    expect(extractInputPosition(xml, GUID)?.positionMs).toBe(700);
  });

  it('returns undefined for a GUID that is not in the state', () => {
    expect(extractInputPosition(stateXml('position="1"'), 'no-such-guid')).toBeUndefined();
  });

  it('returns undefined for an input with no position, like a camera', () => {
    const xml = `<vmix><inputs><input key="${GUID}" type="Capture" title="Cam 1"/></inputs></vmix>`;
    expect(extractInputPosition(xml, GUID)).toBeUndefined();
  });

  it('never reports a negative position', () => {
    expect(extractInputPosition(stateXml('position="-5"'), GUID)?.positionMs).toBe(0);
  });

  it('reads an input written with a closing tag as well as a self-closing one', () => {
    const xml = `<vmix><inputs><input key="${GUID}" position="42"><overlay index="0"/></input></inputs></vmix>`;
    expect(extractInputPosition(xml, GUID)?.positionMs).toBe(42);
  });
});

/** Serves one canned state document per tick, so position is fully controlled. */
function driverHarness(positions: (string | Error)[]) {
  const adapter = new StubAdapter('venue');
  let tick = 0;
  const fetchImpl = (async () => {
    const next = positions[Math.min(tick++, positions.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next, { status: 200 });
  }) as unknown as typeof fetch;

  const driver = new PlayDriver({
    segments: SEGMENTS,
    adapter,
    inputGuid: GUID,
    baseUrl: 'http://vmix.test:8088',
    fetchImpl,
  });
  return { driver, adapter };
}

describe('the playback driver', () => {
  it('shows the cue under the playhead', async () => {
    const { driver, adapter } = driverHarness([stateXml('position="1000"')]);
    await driver.tick();
    expect(adapter.shown()).toEqual(['English 0']);
  });

  it('does not re-send the same cue on every poll', async () => {
    const { driver, adapter } = driverHarness([stateXml('position="1000"')]);
    await driver.tick();
    await driver.tick();
    await driver.tick();
    // Re-showing would restart the overlay's fade four times a second.
    expect(adapter.shown()).toEqual(['English 0']);
  });

  it('changes caption as playback moves into the next cue', async () => {
    const { driver, adapter } = driverHarness([
      stateXml('position="1000"'),
      stateXml('position="5000"'),
    ]);
    await driver.tick();
    await driver.tick();
    expect(adapter.shown()).toEqual(['English 0', 'English 1']);
  });

  it('clears in the gap between cues, then shows again', async () => {
    const { driver, adapter } = driverHarness([
      stateXml('position="1000"'),
      stateXml('position="3000"'),
      stateXml('position="5000"'),
    ]);
    await driver.tick();
    await driver.tick();
    await driver.tick();

    expect(adapter.calls.map((call) => call.action)).toEqual(['show', 'clear', 'show']);
  });

  it('clears only once while the gap lasts', async () => {
    const { driver, adapter } = driverHarness([
      stateXml('position="1000"'),
      stateXml('position="3000"'),
      stateXml('position="3100"'),
    ]);
    await driver.tick();
    await driver.tick();
    await driver.tick();

    expect(adapter.calls.filter((call) => call.action === 'clear')).toHaveLength(1);
  });

  it('follows a backwards seek', async () => {
    const { driver, adapter } = driverHarness([
      stateXml('position="7000"'),
      stateXml('position="1000"'),
    ]);
    await driver.tick();
    await driver.tick();
    expect(adapter.shown()).toEqual(['English 2', 'English 0']);
  });

  it('holds the caption while playback is paused', async () => {
    const { driver, adapter } = driverHarness([
      stateXml('state="Paused" position="1000"'),
      stateXml('state="Paused" position="1000"'),
    ]);
    await driver.tick();
    await driver.tick();
    expect(adapter.shown()).toEqual(['English 0']);
    expect(driver.showing).toBe('cue-0');
  });

  it('keeps polling when vMix is unreachable rather than giving up', async () => {
    const { driver, adapter } = driverHarness([
      new Error('ECONNREFUSED'),
      stateXml('position="1000"'),
    ]);
    await driver.tick();
    expect(adapter.calls).toEqual([]);

    // A projector losing captions must never stop playback, and vMix coming
    // back should bring captions back with it.
    await driver.tick();
    expect(adapter.shown()).toEqual(['English 0']);
  });

  it('clears when the input disappears from the state', async () => {
    const { driver, adapter } = driverHarness([
      stateXml('position="1000"'),
      '<vmix><inputs></inputs></vmix>',
    ]);
    await driver.tick();
    await driver.tick();
    expect(adapter.calls.at(-1)?.action).toBe('clear');
  });
});
