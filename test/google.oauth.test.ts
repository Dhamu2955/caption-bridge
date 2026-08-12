import { describe, expect, it } from 'vitest';

import { GoogleAuth, googleRequest, readApiError } from '../src/google/oauth.js';

/**
 * This code ran as two private methods inside YoutubeClient for a year and is
 * covered end-to-end by youtube.client.test.ts. What is pinned here is what
 * that test cannot see now it is shared: that a second consumer gets the same
 * caching, the same one-shot re-mint, and its OWN re-auth instruction.
 */

const EPOCH = Date.parse('2026-08-02T18:30:00.000Z');

function tokenEndpoint(responses: (Response | Error)[] = []) {
  const calls: { url: string; body: string }[] = [];
  let at = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init.body ?? '') });
    const next = responses[at++];
    if (next instanceof Error) throw next;
    return next ?? Response.json({ access_token: `tok-${at}`, expires_in: 3600 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const auth = (fetchImpl: typeof fetch, now: () => number) =>
  new GoogleAuth({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    reauthCommand: 'doc --auth',
    fetchImpl,
    now,
  });

describe('minting an access token', () => {
  it('sends the refresh grant Google expects', async () => {
    const { calls, fetchImpl } = tokenEndpoint();
    await auth(fetchImpl, () => EPOCH).token();

    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh');
    expect(body.get('client_id')).toBe('id');
  });

  it('caches until a minute before expiry', async () => {
    const { calls, fetchImpl } = tokenEndpoint();
    let clock = EPOCH;
    const source = auth(fetchImpl, () => clock);

    expect(await source.token()).toBe('tok-1');
    clock = EPOCH + 3_500_000;
    expect(await source.token()).toBe('tok-1');
    expect(calls).toHaveLength(1);

    // Inside the skew window: minted again so a slow call cannot straddle it.
    clock = EPOCH + 3_560_000;
    expect(await source.token()).toBe('tok-2');
  });

  it('names the command that re-mints THIS credential', async () => {
    // Two credentials exist now. Telling somebody to re-run the wrong one
    // costs an afternoon and leaves the real problem in place.
    const { fetchImpl } = tokenEndpoint([
      new Response('{"error":"invalid_grant"}', { status: 400 }),
    ]);
    await expect(auth(fetchImpl, () => EPOCH).token()).rejects.toThrow(/doc --auth/);
  });
});

describe('an authenticated request', () => {
  function api(responses: (Response | Error)[]) {
    let at = 0;
    const sent: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      // The token endpoint answers anything posted as form-encoded.
      if (String(url).includes('oauth2')) {
        return Response.json({ access_token: `tok-${sent.length}`, expires_in: 3600 });
      }
      sent.push(new Headers(init.headers).get('Authorization') ?? '');
      const next = responses[at++];
      if (next instanceof Error) throw next;
      return next ?? new Response('ok');
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  }

  const call = (fetchImpl: typeof fetch) =>
    googleRequest(
      'https://docs.test/v1/documents/x:batchUpdate',
      { method: 'POST' },
      {
        auth: auth(fetchImpl, () => EPOCH),
        fetchImpl,
        sleep: async () => {},
      },
    );

  it('carries the bearer token', async () => {
    const { sent, fetchImpl } = api([]);
    await call(fetchImpl);
    expect(sent[0]).toMatch(/^Bearer tok-/);
  });

  it('re-mints once on a 401 and retries', async () => {
    // A token can be revoked mid-service; failing the rest of a sermon over it
    // would be absurd.
    const { sent, fetchImpl } = api([new Response('no', { status: 401 }), new Response('ok')]);
    const response = await call(fetchImpl);
    expect(response.ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('gives up on a second 401, which is a real credentials problem', async () => {
    const { fetchImpl } = api([
      new Response('no', { status: 401 }),
      new Response('no', { status: 401 }),
    ]);
    await expect(call(fetchImpl)).rejects.toThrow(/401/);
  });

  it('backs off on a 429 and succeeds when it clears', async () => {
    const { sent, fetchImpl } = api([new Response('slow', { status: 429 }), new Response('ok')]);
    await expect(call(fetchImpl)).resolves.toBeTruthy();
    expect(sent).toHaveLength(2);
  });

  it('throws immediately on a 403, because retrying never helps', async () => {
    const { sent, fetchImpl } = api([new Response('nope', { status: 403 })]);
    await expect(call(fetchImpl)).rejects.toThrow(/403/);
    expect(sent).toHaveLength(1);
  });
});

describe('reading a Google error', () => {
  it('pulls out the reason every Google API nests the same way', async () => {
    const body = JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } });
    expect(await readApiError(new Response(body, { status: 403 }))).toMatchObject({
      reason: 'quotaExceeded',
    });
  });

  it('truncates, so an HTML error page does not fill the log with markup', async () => {
    const { detail } = await readApiError(new Response('x'.repeat(2000), { status: 500 }));
    expect(detail.length).toBeLessThan(520);
  });

  it('survives a body it cannot read', async () => {
    expect(await readApiError(new Response('', { status: 500 }))).toEqual({ detail: '' });
  });
});
