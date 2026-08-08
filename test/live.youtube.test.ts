import { describe, expect, it } from 'vitest';

import {
  YoutubeLiveAdapter,
  checkIngestionUrl,
  formatCaptionTimestamp,
} from '../src/live/adapters/youtubeLive.js';
import { StubAdapter } from '../src/live/adapters/stub.js';
import { CaptionQueue } from '../src/live/pipeline/queue.js';
import {
  listAudioDevices,
  looksLikeBus,
  parseAvfoundationDevices,
  parseDshowDevices,
} from '../src/live/devices.js';
import type { CaptionLine, OutputConfig } from '../src/live/types.js';

const EPOCH = Date.UTC(2026, 7, 2, 18, 30, 0);

const line = (id: string, audioStartMs: number, text = id): CaptionLine => ({
  id,
  original: `gu-${text}`,
  translation: text,
  audioStartMs,
  audioEndMs: audioStartMs + 2000,
  speaker: '1',
});

interface Post {
  url: string;
  body: string;
}

function harness(responses: (Response | Error)[] = []) {
  const posts: Post[] = [];
  const errors: Error[] = [];
  let at = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    posts.push({ url: String(url), body: String(init.body ?? '') });
    const next = responses[at++];
    if (next instanceof Error) throw next;
    return next ?? new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  return { posts, errors, fetchImpl };
}

describe('YouTube live captions', () => {
  it('posts the English translation with a timestamp line', async () => {
    const { posts, fetchImpl } = harness();
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/closedcaption?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
    });

    await adapter.show(line('a', 0, 'Devotion is the path.'));

    expect(posts[0]?.body).toBe('2026-08-02T18:30:00.000\nDevotion is the path.\n');
  });

  it('timestamps against audio position, not arrival (INVARIANT 9)', () => {
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
    });

    expect(adapter.timestampFor(line('a', 90_000))).toBe('2026-08-02T18:31:30.000');
  });

  it('shifts by the stream offset, because the caption must match the delayed video', () => {
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      streamOffsetMs: 180_000,
    });

    // Spoken at 0s, but the encoder holds the video three minutes, so the
    // words reach YouTube's timeline three minutes in.
    expect(adapter.timestampFor(line('a', 0))).toBe('2026-08-02T18:33:00.000');
  });

  it('numbers posts from one, in order', async () => {
    const { posts, fetchImpl } = harness();
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
    });

    await adapter.show(line('a', 0));
    await adapter.show(line('b', 3000));

    expect(posts[0]?.url).toContain('&seq=1');
    expect(posts[1]?.url).toContain('&seq=2');
  });

  it('starts the query string when the URL has none', async () => {
    const { posts, fetchImpl } = harness();
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc',
      sessionEpoch: EPOCH,
      fetchImpl,
    });

    await adapter.show(line('a', 0));
    expect(posts[0]?.url).toBe('http://upload.test/cc?seq=1');
  });

  it('does not burn a sequence number on a failed post', async () => {
    // The endpoint counts on an unbroken series. Spending a number on a POST
    // YouTube never accepted leaves a gap it cannot account for.
    const { posts, fetchImpl } = harness([new Error('ECONNRESET')]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
      onError: () => {},
    });

    await adapter.show(line('a', 0));
    await adapter.show(line('b', 3000));

    expect(posts[0]?.url).toContain('&seq=1');
    expect(posts[1]?.url).toContain('&seq=1');
  });

  it('reports a failed post without throwing into the scheduler', async () => {
    const errors: Error[] = [];
    const { fetchImpl } = harness([new Error('ECONNRESET')]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
      onError: (err) => errors.push(err),
    });

    // A caption that does not land must never take the broadcast with it.
    await expect(adapter.show(line('a', 0))).resolves.toBeUndefined();
    expect(errors[0]?.message).toContain('ECONNRESET');
  });

  it('reports a non-2xx response too', async () => {
    const errors: Error[] = [];
    const { fetchImpl } = harness([new Response('nope', { status: 403 })]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
      onError: (err) => errors.push(err),
    });

    await adapter.show(line('a', 0));
    expect(errors[0]?.message).toContain('403');
  });

  it('sends nothing on clear — a closed caption is not an overlay to blank', () => {
    const { posts, fetchImpl } = harness();
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
    });

    adapter.clear();
    expect(posts).toEqual([]);
  });

  it('formats timestamps as UTC with no zone suffix', () => {
    expect(formatCaptionTimestamp(EPOCH)).toBe('2026-08-02T18:30:00.000');
    expect(formatCaptionTimestamp(EPOCH)).not.toContain('Z');
  });
});

describe('checkIngestionUrl', () => {
  it('accepts the URL YouTube hands back', () => {
    const result = checkIngestionUrl('https://upload.youtube.com/closedcaption?cid=abc-123');
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('refuses something that is not a URL', () => {
    expect(checkIngestionUrl('paste the url here').ok).toBe(false);
    expect(checkIngestionUrl('').error).toContain('empty');
  });

  it('refuses a non-http scheme', () => {
    expect(checkIngestionUrl('ftp://upload.test/cc?cid=abc').ok).toBe(false);
  });

  it('warns rather than refuses when the cid is missing', () => {
    // The wire format is not verifiable from this codebase, so a surprising
    // URL is flagged, never rejected.
    const result = checkIngestionUrl('https://upload.youtube.com/closedcaption');
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('cid');
  });

  it('warns about a seq the operator pasted in', () => {
    const result = checkIngestionUrl('https://upload.test/cc?cid=abc&seq=7');
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('seq');
  });
});

/**
 * The reviewer's decisions have to reach YouTube.
 *
 * The closed-caption output is registered under its own name while carrying the
 * `stream` output's schedule. Scoping a drop to `'stream'` alone therefore
 * skipped it, and a line the reviewer had rejected still went out as a caption
 * on the public stream — the one place a bad translation is permanent.
 */
describe('reviewer decisions reach the YouTube output', () => {
  const STREAM: OutputConfig = {
    name: 'stream',
    delayMs: 184_000,
    reviewed: true,
    minDisplayMs: 1500,
    lateSkipMs: 2000,
  };

  function setup() {
    const { posts, fetchImpl } = harness();
    const queue = new CaptionQueue({ sessionEpoch: EPOCH });
    const overlay = new StubAdapter('stream');
    const youtube = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      sessionEpoch: EPOCH,
      fetchImpl,
    });

    queue.addOutput(STREAM, overlay);
    queue.addOutput({ ...STREAM, name: 'youtube' }, youtube);

    // What runLive scopes reviewer actions to once both outputs exist.
    const reviewed = ['stream', 'youtube'];
    return { queue, overlay, posts, reviewed };
  }

  it('a dropped line is never posted', async () => {
    const { queue, overlay, posts, reviewed } = setup();

    queue.add(line('a', 0, 'A bad translation.'));
    queue.drop('a', 'reviewer', reviewed);
    queue.tick(EPOCH + 184_000 + 1);
    await Promise.resolve();

    expect(overlay.shown()).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('an edited line is posted with the correction', async () => {
    const { queue, posts, reviewed } = setup();

    queue.add(line('a', 0, 'Machine wording.'));
    queue.editLine('a', 'The corrected line.', 'reviewer', reviewed);
    queue.tick(EPOCH + 184_000 + 1);
    await Promise.resolve();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toContain('The corrected line.');
    expect(posts[0]?.body).not.toContain('Machine wording.');
  });

  it('still leaves unreviewed outputs alone', async () => {
    const { queue, reviewed } = setup();
    const venue = new StubAdapter('venue');
    queue.addOutput({ ...STREAM, name: 'venue', delayMs: 4000, reviewed: false }, venue);

    queue.add(line('a', 0, 'Machine wording.'));
    queue.drop('a', 'reviewer', reviewed);
    queue.tick(EPOCH + 4001);
    await Promise.resolve();

    // The venue screen showed it four seconds in; a drop three minutes later
    // cannot un-show it, and must not try.
    expect(venue.shown()).toHaveLength(1);
  });
});

const DSHOW_STDERR = `[dshow @ 0000019] "Integrated Camera" (video)
[dshow @ 0000019]   Alternative name "@device_pnp_..."
[dshow @ 0000019] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 0000019] "CABLE Output (VB-Audio Virtual Cable)" (audio)
dummy: Immediate exit requested`;

const AVFOUNDATION_STDERR = `[AVFoundation indev @ 0x7f8] AVFoundation video devices:
[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8] [1] Capture screen 0
[AVFoundation indev @ 0x7f8] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7f8] [1] BlackHole 2ch`;

describe('audio device enumeration', () => {
  it('takes only the audio devices from a dshow listing', () => {
    expect(parseDshowDevices(DSHOW_STDERR)).toEqual([
      'Microphone (Realtek(R) Audio)',
      'CABLE Output (VB-Audio Virtual Cable)',
    ]);
  });

  it('does not offer cameras as sound inputs on macOS', () => {
    expect(parseAvfoundationDevices(AVFOUNDATION_STDERR)).toEqual([
      'MacBook Pro Microphone',
      'BlackHole 2ch',
    ]);
  });

  it('flags the virtual cables, since picking Master is the failure to prevent', () => {
    // INVARIANT 6 — the single biggest accuracy loss available is tapping the
    // main mix, and a dropdown makes that a one-click mistake.
    expect(looksLikeBus('CABLE Output (VB-Audio Virtual Cable)')).toBe(true);
    expect(looksLikeBus('BlackHole 2ch')).toBe(true);
    expect(looksLikeBus('VoiceMeeter Output')).toBe(true);
    expect(looksLikeBus('Microphone (Realtek(R) Audio)')).toBe(false);
  });

  it('returns names exactly as --device needs them', async () => {
    const devices = await listAudioDevices('dshow', {
      execImpl: async () => ({ stderr: DSHOW_STDERR }),
    });

    expect(devices).toEqual([
      { name: 'Microphone (Realtek(R) Audio)', likelyBus: false },
      { name: 'CABLE Output (VB-Audio Virtual Cable)', likelyBus: true },
    ]);
  });

  it('passes the right ffmpeg arguments per platform', async () => {
    const calls: string[][] = [];
    const execImpl = async (_command: string, args: string[]) => {
      calls.push(args);
      return { stderr: '' };
    };

    await listAudioDevices('dshow', { execImpl });
    await listAudioDevices('avfoundation', { execImpl });

    expect(calls[0]).toEqual(['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    expect(calls[1]).toEqual(['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  });

  it('returns an empty list rather than throwing when ffmpeg says nothing', async () => {
    await expect(
      listAudioDevices('dshow', { execImpl: async () => ({ stderr: '' }) }),
    ).resolves.toEqual([]);
  });

  it('does not list the same device twice', async () => {
    const repeated = `${DSHOW_STDERR}\n[dshow @ 1] "CABLE Output (VB-Audio Virtual Cable)" (audio)`;
    const devices = await listAudioDevices('dshow', {
      execImpl: async () => ({ stderr: repeated }),
    });
    expect(devices).toHaveLength(2);
  });
});
