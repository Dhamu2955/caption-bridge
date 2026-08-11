import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { AudioCapture } from '../src/live/capture.js';
import { LiveSession, type SessionSink } from '../src/live/session.js';
import { BrowserAdapter } from '../src/live/adapters/browser.js';
import { SonioxRealtimeClient } from '../src/live/soniox/client.js';
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

  /** Provisional tokens, the kind that get revised. Must never reach a screen. */
  sayProvisionally(text: string, startMs: number): void {
    this.emit('tokens', [
      { text, start_ms: startMs, end_ms: startMs + 1500, is_final: false, speaker: '1', language: 'gu' },
      { text, start_ms: 0, end_ms: 0, is_final: false, speaker: '1', language: 'en', translation_status: 'translation' },
    ]);
  }
}

function collectSink(): SessionSink & { events: QueueEvent[] } {
  const events: QueueEvent[] = [];
  return { events, notify: (event) => events.push(event) };
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

function build(overlay: BrowserAdapter, sink: SessionSink, live: Record<string, number> = {}) {
  const capture = new FakeCapture({ device: 'CABLE Output', sampleRate: 16000 });
  let client: FakeClient | undefined;
  const session = new LiveSession({
    // liveSrt off: these run dozens of times and would litter recordings/ with
    // empty files. The writer has its own tests.
    config: parseConfig({ live: { liveSrt: false, ...live } }),
    apiKey: 'sk-test',
    device: 'CABLE Output',
    overlay,
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
    const overlay = new BrowserAdapter('captions');
    const { sent, socket } = fakeOverlaySocket();
    overlay.attach(socket);

    const first = build(overlay, collectSink(), noDelay);
    first.session.start();
    await first.session.stop();

    const second = build(overlay, collectSink(), noDelay);
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
    const overlay = new BrowserAdapter('captions');
    const { sent, socket } = fakeOverlaySocket();
    overlay.attach(socket);

    const { session } = build(overlay, collectSink());
    session.start();
    await session.stop();

    // A finished service must not leave its last line on the projector.
    expect(sent).toContainEqual({ type: 'clear' });
  });

  it('a socket attached before a session is still attached after it', async () => {
    // The reason the adapter is owned by the server rather than the session:
    // BridgeServer binds a socket to this instance at upgrade and never looks
    // it up again, so a session that replaced it would leave every vMix Browser
    // input connected to an orphan — open, healthy-looking, permanently silent.
    const overlay = new BrowserAdapter('captions');
    const socket = fakeOverlaySocket();
    overlay.attach(socket.socket);

    const { session } = build(overlay, collectSink());
    session.start();
    await session.stop();

    overlay.show({
      id: 'after',
      original: 'ભક્તિ',
      translation: 'Still connected.',
      audioStartMs: 0,
      audioEndMs: 2000,
      speaker: '1',
    });
    expect(socket.sent).toContainEqual({
      type: 'show',
      line: expect.objectContaining({ translation: 'Still connected.' }),
    });
  });
});

describe('pause is not stop', () => {
  it('pauseCapture stops audio but leaves the session alive', () => {
    const overlay = new BrowserAdapter('captions');
    const { session, capture, client } = build(overlay, collectSink());
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
    const overlay = new BrowserAdapter('captions');
    const { session, capture, client } = build(overlay, collectSink());
    session.start();
    session.pauseCapture();

    session.resumeCapture('Different Input');

    expect(capture.starts).toBe(2);
    expect(session.status.device).toBe('Different Input');
    expect(session.status.running).toBe(true);
    expect(client.closes).toBe(0);
  });

  it('stop closes the client, unlike pause', async () => {
    const overlay = new BrowserAdapter('captions');
    const { session, client } = build(overlay, collectSink());
    session.start();

    await session.stop();

    expect(client.closes).toBe(1);
    expect(session.status.state).toBe('stopped');
  });

  it('stop is idempotent, because it runs on the shutdown path', async () => {
    const overlay = new BrowserAdapter('captions');
    const { session, client } = build(overlay, collectSink());
    session.start();

    await session.stop();
    await session.stop();

    expect(client.closes).toBe(1);
  });

});

describe('the one overlay', () => {
  it('reports its connection count for the status endpoint', () => {
    const overlay = new BrowserAdapter('captions');
    expect(overlay.connections).toBe(0);
    overlay.attach(fakeOverlaySocket().socket);
    expect(overlay.connections).toBe(1);
  });
});

describe('nothing rewrites itself on air', () => {
  /**
   * The guarantee this whole pipeline is shaped around, and the failure it
   * exists to prevent: another mandir rendered partial results and watched
   * sentences restructure themselves mid-air, which was worse than no captions.
   * Gujarati is verb-final, so a revision re-orders the clause rather than
   * fixing a word — no amount of fading hides it.
   *
   * Four things stop it, and this covers the one that would break silently.
   */
  it('shows a line once it is final, and never before', async () => {
    const overlay = new BrowserAdapter('captions');
    const socket = fakeOverlaySocket();
    overlay.attach(socket.socket);

    const { session, client } = build(overlay, collectSink());
    session.start();

    client.sayProvisionally('ભક્તિ', 0);
    client.sayProvisionally('ભક્તિ એ', 0);
    expect(socket.sent).toEqual([]);

    client.say('ભક્તિ એ માર્ગ છે.', 0);
    const shown = socket.sent.filter((m) => (m as { type: string }).type === 'show');
    expect(shown).toHaveLength(1);

    await session.stop();
  });

  it('never asks Soniox for provisional tokens at all', () => {
    // Belt and braces: the builder discards them, but not requesting them means
    // a future change cannot route them somewhere by accident.
    const overlay = new BrowserAdapter('captions');
    const { session } = build(overlay, collectSink());
    expect(session).toBeDefined();

    const client = new SonioxRealtimeClient({
      apiKey: 'sk-test',
      model: 'stt-rt-v5',
      sampleRate: 16000,
      languageHints: ['gu'],
      targetLanguage: 'en',
    });
    expect(client.buildConfigMessage()['include_nonfinal']).toBe(false);
  });
});
