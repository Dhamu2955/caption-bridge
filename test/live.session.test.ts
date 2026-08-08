import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { AudioCapture } from '../src/live/capture.js';
import { LiveSession, type SessionSink } from '../src/live/session.js';
import { OverlayRegistry } from '../src/live/overlays.js';
import { SonioxRealtimeClient } from '../src/live/soniox/client.js';
import type { OperatorView } from '../src/live/server.js';
import type { QueueEvent } from '../src/live/types.js';
import type { SonioxToken } from '../src/soniox/types.js';

/**
 * The session is disposable; the server outlives it. Everything here is about
 * that boundary, because the failure it can cause is silent: an overlay page
 * that still looks connected and never shows another caption.
 */

/** No ffmpeg. Start/stop are recorded so the pause contract can be asserted. */
class FakeCapture extends AudioCapture {
  starts = 0;
  stops = 0;
  override start(): void {
    this.starts++;
  }
  override stop(): void {
    this.stops++;
  }
}

/** No websocket, and no recorder file. */
class FakeClient extends SonioxRealtimeClient {
  connects = 0;
  closes = 0;
  override connect(): void {
    this.connects++;
  }
  override async close(): Promise<void> {
    this.closes++;
  }
  override sendAudio(): boolean {
    return true;
  }
  override recordEvent(): void {}
  /** Feed the pipeline as if Soniox had returned final tokens. */
  say(text: string, startMs: number): void {
    const tokens: SonioxToken[] = [
      {
        text,
        start_ms: startMs,
        end_ms: startMs + 1500,
        is_final: true,
        speaker: '1',
        language: 'gu',
      },
      {
        text,
        start_ms: 0,
        end_ms: 0,
        is_final: true,
        speaker: '1',
        language: 'en',
        translation_status: 'translation',
      },
      { text: '<end>', start_ms: startMs + 1500, end_ms: startMs + 1500, is_final: true },
    ];
    this.emit('tokens', tokens);
  }
}

function collectSink(): SessionSink & { views: OperatorView[]; events: QueueEvent[] } {
  const views: OperatorView[] = [];
  const events: QueueEvent[] = [];
  return {
    views,
    events,
    publish: (view) => views.push(view),
    notify: (event) => events.push(event),
  };
}

/** Stands in for a vMix Browser input that is already on screen. */
function fakeOverlaySocket() {
  const sent: unknown[] = [];
  return {
    sent,
    socket: {
      send: (data: string) => sent.push(JSON.parse(data)),
      get open() {
        return true;
      },
    },
  };
}

function build(overlays: OverlayRegistry, sink: SessionSink, live: Record<string, number> = {}) {
  const capture = new FakeCapture({ device: 'CABLE Output', sampleRate: 16000 });
  let client: FakeClient | undefined;
  const session = new LiveSession({
    config: parseConfig({ live }),
    apiKey: 'sk-test',
    device: 'CABLE Output',
    outputs: ['venue', 'stream'],
    overlays,
    sink,
    createCapture: () => capture,
    createClient: (options) => {
      client = new FakeClient({ ...options, recordPath: undefined });
      return client;
    },
  });
  return { session, capture, client: client! };
}

describe('overlay adapters outlive the session', () => {
  it('a page attached before a restart still receives the next session', async () => {
    // The whole reason OverlayRegistry exists. If the adapters were rebuilt per
    // session, this socket would stay OPEN and go permanently silent — which on
    // a Sunday is indistinguishable from nobody speaking.
    //
    // No delay, so the queue's own 100ms tick releases the line rather than the
    // test reaching past the session to poke the adapter directly.
    const noDelay = { delayAssemblyMs: 0, delayReviewMs: 0 };
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const { sent, socket } = fakeOverlaySocket();
    overlays.get('venue')!.attach(socket);

    const first = build(overlays, collectSink(), noDelay);
    first.session.start();
    await first.session.stop();

    const second = build(overlays, collectSink(), noDelay);
    second.session.start();
    second.client.say('Bhakti is the path.', 0);
    await new Promise((r) => setTimeout(r, 250));
    await second.session.stop();

    const shown = sent
      .filter((m): m is { type: 'show'; line: { translation: string } } =>
        (m as { type: string }).type === 'show',
      )
      .map((m) => m.line.translation);

    expect(shown).toContain('Bhakti is the path.');
  });

  it('blanks the overlays at a session boundary instead of freezing', async () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const { sent, socket } = fakeOverlaySocket();
    overlays.get('venue')!.attach(socket);

    const { session } = build(overlays, collectSink());
    session.start();
    await session.stop();

    // A finished service must not leave its last line on the projector.
    expect(sent).toContainEqual({ type: 'clear' });
  });

  it('keeps the same adapter instances across sessions', async () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const before = overlays.get('venue');

    const { session } = build(overlays, collectSink());
    session.start();
    await session.stop();

    expect(overlays.get('venue')).toBe(before);
  });
});

describe('pause is not stop', () => {
  it('pauseCapture stops audio but leaves the session alive', () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const { session, capture, client } = build(overlays, collectSink());
    session.start();

    session.pauseCapture();

    // Capture stopped...
    expect(capture.stops).toBe(1);
    expect(session.status.running).toBe(false);
    // ...but Soniox is still connected and the queue is still draining, so the
    // three minutes already spoken still reach air.
    expect(client.closes).toBe(0);
    expect(session.status.state).toBe('paused');
  });

  it('resumeCapture can switch device without ending the session', () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const { session, capture, client } = build(overlays, collectSink());
    session.start();
    session.pauseCapture();

    session.resumeCapture('Different Input');

    expect(capture.starts).toBe(2);
    expect(session.status.device).toBe('Different Input');
    expect(session.status.running).toBe(true);
    expect(client.closes).toBe(0);
  });

  it('stop closes the client, unlike pause', async () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const { session, client } = build(overlays, collectSink());
    session.start();

    await session.stop();

    expect(client.closes).toBe(1);
    expect(session.status.state).toBe('stopped');
  });

  it('stop is idempotent, because it runs on the shutdown path', async () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const { session, client } = build(overlays, collectSink());
    session.start();

    await session.stop();
    await session.stop();

    expect(client.closes).toBe(1);
  });

  it('empties the reviewer view on stop rather than leaving stale cards', async () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    const sink = collectSink();
    const { session } = build(overlays, sink);
    session.start();

    await session.stop();

    expect(sink.views.at(-1)?.pending).toEqual([]);
  });
});

describe('OverlayRegistry', () => {
  it('reports connections per output for the status endpoint', () => {
    const overlays = new OverlayRegistry(['venue', 'stream']);
    overlays.get('venue')!.attach(fakeOverlaySocket().socket);

    expect(overlays.connections()).toEqual({ venue: 1, stream: 0 });
  });
});
