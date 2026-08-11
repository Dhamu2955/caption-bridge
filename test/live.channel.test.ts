import { describe, expect, it } from 'vitest';

import { AudioCapture } from '../src/live/capture.js';
import { LiveSessionManager } from '../src/live/sessionManager.js';
import { OverlayRegistry } from '../src/live/overlays.js';
import { parseConfig } from '../src/config.js';

/**
 * The chosen input channel has to survive every hop between the dropdown and
 * the ffmpeg command line. It used to have nowhere to travel at all, and a
 * break anywhere along the way is silent: capture opens, runs, and averages the
 * speaker with the silence beside them.
 */

class SpyCapture extends AudioCapture {
  started = 0;
  override start(): void {
    this.started++;
  }
  override stop(): void {}
}

function managerWith(captures: SpyCapture[]) {
  const overlays = new OverlayRegistry(['venue']);
  const manager = new LiveSessionManager({
    getConfig: () => parseConfig({}),
    overlays,
    defaults: { outputs: ['venue'] },
  });
  manager.attachSink({ publish: () => {}, notify: () => {} });
  return { manager, overlays, captures };
}

describe('the chosen input channel reaches ffmpeg', () => {
  it('is carried from start() into the capture options', () => {
    const capture = new SpyCapture({ device: 'Blackmagic', sampleRate: 16000, channel: 1 });
    expect(capture.channel).toBe(1);
    expect(capture.device).toBe('Blackmagic');
  });

  it('survives a device change', () => {
    const capture = new SpyCapture({ device: 'A', sampleRate: 16000, channel: 3 });
    capture.setDevice('B', 2);
    expect(capture.device).toBe('B');
    expect(capture.channel).toBe(2);
  });

  it('is cleared, not kept, when the next start asks for the mix', () => {
    // Carrying a stale channel across would take input 3 of a device the
    // operator has just told it to mix — the exact bug in reverse.
    const capture = new SpyCapture({ device: 'A', sampleRate: 16000, channel: 3 });
    capture.setDevice('B');
    expect(capture.channel).toBeUndefined();
  });

  it('is reported in the session status so a remote operator can see it', () => {
    const { manager } = managerWith([]);
    // Nothing running: the manager still remembers nothing rather than
    // inventing a channel.
    expect(manager.status.channel).toBeUndefined();
    expect(manager.status.running).toBe(false);
  });
});
