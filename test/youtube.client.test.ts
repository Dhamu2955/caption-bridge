import { describe, expect, it } from 'vitest';

import { YoutubeClient, YoutubeError } from '../src/youtube/client.js';
import { QUOTA_COST, QUOTA_REASONS } from '../src/youtube/types.js';

/**
 * No vi.mock anywhere — fetch is injected, matching how the Soniox client and
 * the vMix adapter are tested.
 */

interface Call {
  url: string;
  method: string;
  body: string;
  authorization: string | null;
  contentType: string | null;
}

const TOKEN_URL = 'https://oauth.test/token';
const BASE_URL = 'https://api.test/youtube/v3';
const UPLOAD_URL = 'https://api.test/upload/youtube/v3';

/**
 * Records every request and replies from a queue of handlers. A handler
 * returning undefined falls through to a generic 200, so a test only spells out
 * the responses it cares about.
 */
function harness(handlers: ((call: Call) => Response | undefined)[] = []) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const raw = init.body;
    const body =
      typeof raw === 'string'
        ? raw
        : raw instanceof URLSearchParams
          ? raw.toString()
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : '';
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      body,
      authorization: headers.get('Authorization'),
      contentType: headers.get('Content-Type'),
    };
    calls.push(call);

    for (const handler of handlers) {
      const response = handler(call);
      if (response) return response;
    }
    if (call.url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'token-1', expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ id: 'track-new' }), { status: 200 });
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

function client(
  fetchImpl: typeof fetch,
  over: Partial<ConstructorParameters<typeof YoutubeClient>[0]> = {},
) {
  return new YoutubeClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    baseUrl: BASE_URL,
    uploadUrl: UPLOAD_URL,
    tokenUrl: TOKEN_URL,
    fetchImpl,
    sleep: async () => {},
    now: () => 1_000_000,
    boundary: 'TESTBOUNDARY',
    ...over,
  });
}

const SRT = '1\n00:00:01,000 --> 00:00:04,000\nસેવા એ જ ધર્મ છે.\n';

describe('access tokens', () => {
  it('mints one from the refresh token before the first call', async () => {
    const { calls, fetchImpl } = harness();
    await client(fetchImpl).listCaptions('vid-1');

    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toContain('grant_type=refresh_token');
    expect(calls[0]?.body).toContain('refresh_token=refresh-token');
    expect(calls[1]?.authorization).toBe('Bearer token-1');
  });

  it('reuses the token across calls rather than minting one per request', async () => {
    const { calls, fetchImpl } = harness();
    const api = client(fetchImpl);
    await api.listCaptions('vid-1');
    await api.listCaptions('vid-2');

    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it('re-mints once the cached token is inside the expiry skew', async () => {
    const { calls, fetchImpl } = harness([
      (call) =>
        call.url === TOKEN_URL
          ? new Response(JSON.stringify({ access_token: 'short', expires_in: 30 }), { status: 200 })
          : undefined,
    ]);
    const api = client(fetchImpl);
    await api.listCaptions('vid-1');
    await api.listCaptions('vid-2');

    // 30s of life against a 60s skew means the second call cannot reuse it.
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
  });

  it('re-mints and retries exactly once on a 401, then gives up', async () => {
    let apiCalls = 0;
    const { calls, fetchImpl } = harness([
      (call) => {
        if (call.url === TOKEN_URL) return undefined;
        apiCalls++;
        return new Response('{"error":{"errors":[{"reason":"authError"}]}}', { status: 401 });
      },
    ]);

    await expect(client(fetchImpl).listCaptions('vid-1')).rejects.toBeInstanceOf(YoutubeError);
    // One original + one retry. Not a retry storm.
    expect(apiCalls).toBe(2);
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
  });

  it('explains the seven-day trap when the refresh token has expired', async () => {
    const { fetchImpl } = harness([
      (call) =>
        call.url === TOKEN_URL
          ? new Response('{"error":"invalid_grant"}', { status: 400 })
          : undefined,
    ]);

    await expect(client(fetchImpl).listCaptions('vid-1')).rejects.toThrow(/Production/);
  });
});

describe('multipart/related upload body', () => {
  it('sends multipart/related, not the multipart/form-data FormData would produce', async () => {
    const { calls, fetchImpl } = harness();
    await client(fetchImpl).insertCaption('vid-1', 'en', 'English', SRT);

    const upload = calls.at(-1);
    expect(upload?.contentType).toBe('multipart/related; boundary=TESTBOUNDARY');
    expect(upload?.url).toContain('uploadType=multipart');
  });

  it('carries a JSON metadata part and the SRT as a second part', () => {
    const { fetchImpl } = harness();
    const body = client(fetchImpl)
      .buildMultipartBody({ snippet: { videoId: 'vid-1', language: 'en' } }, SRT)
      .toString('utf8');

    expect(body).toBe(
      '--TESTBOUNDARY\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        '{"snippet":{"videoId":"vid-1","language":"en"}}\r\n' +
        '--TESTBOUNDARY\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n' +
        `${SRT}\r\n` +
        '--TESTBOUNDARY--\r\n',
    );
  });

  it('measures Gujarati in bytes, not UTF-16 code units', () => {
    const { fetchImpl } = harness();
    const body = client(fetchImpl).buildMultipartBody({}, 'સેવા');
    // Four Gujarati characters are 12 UTF-8 bytes; a UTF-16 length would say 4.
    expect(body.includes(Buffer.from('સેવા', 'utf8'))).toBe(true);
  });

  it('refuses rather than corrupting the request when text contains the boundary', () => {
    const { fetchImpl } = harness();
    expect(() => client(fetchImpl).buildMultipartBody({}, 'before TESTBOUNDARY after')).toThrow(
      /boundary/,
    );
  });

  it('POSTs to insert and PUTs to update, so a correction replaces the track', async () => {
    const { calls, fetchImpl } = harness();
    const api = client(fetchImpl);

    await api.insertCaption('vid-1', 'en', 'English', SRT);
    expect(calls.at(-1)?.method).toBe('POST');
    expect(calls.at(-1)?.body).toContain('"videoId":"vid-1"');

    await api.updateCaption('track-7', SRT);
    expect(calls.at(-1)?.method).toBe('PUT');
    expect(calls.at(-1)?.body).toContain('"id":"track-7"');
  });
});

describe('errors', () => {
  it('surfaces quotaExceeded as a reason bulk mode can act on', async () => {
    const { fetchImpl } = harness([
      (call) =>
        call.url === TOKEN_URL
          ? undefined
          : new Response(
              JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }], code: 403 } }),
              { status: 403 },
            ),
    ]);

    const error = await client(fetchImpl)
      .listCaptions('vid-1')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(YoutubeError);
    expect((error as YoutubeError).reason).toBe('quotaExceeded');
    expect((error as YoutubeError).isQuotaExhausted).toBe(true);
    expect((error as YoutubeError).status).toBe(403);
  });

  it('does not treat an ordinary 403 as a quota wall', async () => {
    const { fetchImpl } = harness([
      (call) =>
        call.url === TOKEN_URL
          ? undefined
          : new Response(JSON.stringify({ error: { errors: [{ reason: 'forbidden' }] } }), {
              status: 403,
            }),
    ]);

    const error = (await client(fetchImpl)
      .listCaptions('vid-1')
      .catch((err: unknown) => err)) as YoutubeError;

    expect(error.isQuotaExhausted).toBe(false);
  });

  it('retries a 503 and succeeds', async () => {
    let attempts = 0;
    const { fetchImpl } = harness([
      (call) => {
        if (call.url === TOKEN_URL) return undefined;
        attempts++;
        return attempts === 1
          ? new Response('upstream hiccup', { status: 503 })
          : new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    ]);

    await expect(client(fetchImpl).listCaptions('vid-1')).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('fails fast on a 404 rather than burning retries', async () => {
    let attempts = 0;
    const { fetchImpl } = harness([
      (call) => {
        if (call.url === TOKEN_URL) return undefined;
        attempts++;
        return new Response('no such video', { status: 404 });
      },
    ]);

    await expect(client(fetchImpl).listCaptions('vid-1')).rejects.toThrow(/404/);
    expect(attempts).toBe(1);
  });
});

describe('listing', () => {
  it('returns an empty list when the video has no tracks', async () => {
    const { fetchImpl } = harness([
      (call) =>
        call.url.includes('/captions?part=snippet')
          ? new Response(JSON.stringify({}), { status: 200 })
          : undefined,
    ]);

    await expect(client(fetchImpl).listCaptions('vid-1')).resolves.toEqual([]);
  });

  it('encodes the video id', async () => {
    const { calls, fetchImpl } = harness();
    await client(fetchImpl).listCaptions('a/b?c');
    expect(calls.at(-1)?.url).toContain('videoId=a%2Fb%3Fc');
  });
});

describe('quota table', () => {
  it('prices a two-track publish at 800 and a correction at 900', () => {
    expect(QUOTA_COST.insert * 2).toBe(800);
    expect(QUOTA_COST.update * 2).toBe(900);
  });

  it('treats every documented quota reason as exhaustion', () => {
    expect(QUOTA_REASONS.has('quotaExceeded')).toBe(true);
    expect(QUOTA_REASONS.has('dailyLimitExceeded')).toBe(true);
  });
});
