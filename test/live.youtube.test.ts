import { describe, expect, it } from 'vitest';

import {
  YoutubeLiveAdapter,
  checkIngestionUrl,
  formatCaptionTimestamp,
} from '../src/live/adapters/youtubeLive.js';
import { StubAdapter } from '../src/live/adapters/stub.js';
import {
  listAudioDevices,
  looksLikeBus,
  parseAvfoundationDevices,
  parseDshowDevices,
} from '../src/live/devices.js';
import type { CaptionLine } from '../src/live/types.js';

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
      fetchImpl,
      now: () => EPOCH,
    });

    await adapter.show(line('a', 0, 'Devotion is the path.'));

    // The region marker is YouTube's cue positioning. Both this and a bare
    // timestamp are accepted; this is the variant with ten thousand accepted
    // posts behind it from a working prototype of the same job.
    expect(posts[0]?.body).toBe(
      '2026-08-02T18:30:00.000 region:reg1#cue1\nDevotion is the path.\n',
    );
  });

  it('stamps with the send time, so nothing needs calibrating', async () => {
    // The single thing that makes a zero-delay path work: the caption is placed
    // wherever the stream has actually got to, rather than where the words were
    // spoken, so there is no offset and no video delay to keep in step.
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      now: () => EPOCH + 42_000,
    });

    expect(adapter.timestampFor()).toBe('2026-08-02T18:30:42.000');
  });

  it('numbers posts from one, in order', async () => {
    const { posts, fetchImpl } = harness();
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
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
      fetchImpl,
    });

    await adapter.show(line('a', 0));
    expect(posts[0]?.url).toBe('http://upload.test/cc?seq=1');
  });

  it('keeps one number per caption, and every retry of it', async () => {
    const { posts, fetchImpl } = harness([new Error('ECONNRESET')]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      onError: () => {},
    });

    await adapter.show(line('a', 0));
    await adapter.show(line('b', 3000));

    // The retry is the same caption, so it keeps the same number; the caption
    // after it gets the next one.
    expect(posts[0]?.url).toContain('&seq=1');
    expect(posts[1]?.url).toContain('&seq=1');
    expect(posts[2]?.url).toContain('&seq=2');
  });

  it('leaves a gap rather than giving a failed caption\'s number to the next one', async () => {
    // The price of not waiting: a caption dispatched before the one before it
    // has been answered cannot know what number that one ended up using. A gap
    // is a caption missing. Reusing the number, which is what this did while
    // the posts were serialised, risks two different lines claiming the same
    // position — a caption overwritten by the wrong words.
    const { posts, fetchImpl } = harness([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      onError: () => {},
    });

    await adapter.show(line('a', 0));
    await adapter.show(line('b', 3000));

    expect(posts.filter((p) => p.url.includes('&seq=1'))).toHaveLength(4);
    expect(posts[4]?.url).toContain('&seq=2');
  });

  it('does not make a caption wait for the one before it', async () => {
    // The whole point. Measured on the prototype's log of 12,994 posts from the
    // mandir's network, a round trip is a median of 715ms — so a caption queued
    // behind another was STAMPED 715ms later, and YouTube placed it that much
    // further into the stream. Serialised, the second post here could not even
    // begin until the first one answered.
    const posts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const fetchImpl = (async (url: string) => {
      posts.push(String(url));
      if (posts.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
    });

    const first = adapter.show(line('a', 0));
    const second = adapter.show(line('b', 3000));

    // The second caption is on the wire while the first is still hanging.
    await expect(second).resolves.toBeUndefined();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('&seq=2');

    releaseFirst?.();
    await first;
  });

  it('gives up on a post that never answers', async () => {
    // There was no timeout at all. Serialised, one connection that never
    // answered would have held up every caption for the rest of the service.
    const errors: Error[] = [];
    const fetchImpl = (() => new Promise(() => {})) as unknown as typeof fetch;
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      timeoutMs: 20,
      onError: (err) => errors.push(err),
    });

    await adapter.show(line('a', 0));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('timed out');
  });

  it('retries a transient failure rather than losing the caption', async () => {
    // YouTube's own policy, and not a rare path: a working prototype of this
    // job logged 275 failures against 12,473 accepted posts. Before this, one
    // blip took that caption off the broadcast with nothing said.
    const errors: Error[] = [];
    const { posts, fetchImpl } = harness([new Error('ECONNRESET')]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      onError: (err) => errors.push(err),
    });

    await adapter.show(line('a', 0, 'Devotion is the path.'));

    expect(posts).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('gives up after four attempts and says so once', async () => {
    const errors: Error[] = [];
    const { posts, fetchImpl } = harness([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      onError: (err) => errors.push(err),
    });

    await adapter.show(line('a', 0));
    expect(posts).toHaveLength(4);
    expect(errors).toHaveLength(1);
  });

  it('re-stamps each retry, so a backoff does not misplace a "now" caption', async () => {
    // The whole point of `now` mode is that the stamp says where the stream
    // has got to. Carrying the first attempt's stamp through a 400ms backoff
    // would place it before the words it belongs to.
    const { posts, fetchImpl } = harness([new Error('ECONNRESET')]);
    let clock = EPOCH;
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => { clock += 400; },
      now: () => clock,
      onError: () => {},
    });

    await adapter.show(line('a', 0));
    expect(posts[0]?.body).toContain('18:30:00.000');
    expect(posts[1]?.body).toContain('18:30:00.400');
  });

  it('reports a failed post without throwing into the scheduler', async () => {
    const errors: Error[] = [];
    const { fetchImpl } = harness([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      onError: (err) => errors.push(err),
    });

    // A caption that does not land must never take the broadcast with it.
    await expect(adapter.show(line('a', 0))).resolves.toBeUndefined();
    expect(errors[0]?.message).toContain('ECONNRESET');
  });

  it('reports a non-2xx response too', async () => {
    const errors: Error[] = [];
    const { fetchImpl } = harness([
      new Response('nope', { status: 403 }),
      new Response('nope', { status: 403 }),
      new Response('nope', { status: 403 }),
      new Response('nope', { status: 403 }),
    ]);
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
      fetchImpl,
      sleep: async () => {},
      onError: (err) => errors.push(err),
    });

    await adapter.show(line('a', 0));
    expect(errors[0]?.message).toContain('403');
  });

  it('sends nothing on clear — a closed caption is not an overlay to blank', () => {
    const { posts, fetchImpl } = harness();
    const adapter = new YoutubeLiveAdapter({
      ingestionUrl: 'http://upload.test/cc?cid=abc',
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
