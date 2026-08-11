import { describe, expect, it } from 'vitest';

import { GoogleDocsClient, GoogleDocsError } from '../src/google/docs.js';
import { GoogleAuth } from '../src/google/oauth.js';

/**
 * The wire format, pinned. It is the one part of this path that cannot be
 * checked from the code — the same reason `youtube/client.ts` pins its own.
 */

function harness(responses: Response[] = []) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let at = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).includes('oauth2')) {
      return Response.json({ access_token: 'tok', expires_in: 3600 });
    }
    calls.push({
      url: String(url),
      method: String(init.method),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return responses[at++] ?? Response.json({ id: 'doc-1', webViewLink: 'https://docs.test/1' });
  }) as unknown as typeof fetch;

  const client = new GoogleDocsClient({
    auth: new GoogleAuth({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      reauthCommand: 'doc --auth',
      fetchImpl,
    }),
    fetchImpl,
    sleep: async () => {},
    docsBaseUrl: 'https://docs.test/v1',
    driveBaseUrl: 'https://drive.test/v3',
  });
  return { client, calls };
}

describe('creating the doc', () => {
  it('goes through Drive, because Docs cannot set a parent folder', async () => {
    const { client, calls } = harness();
    const created = await client.createDoc('Sermon captions 2026-08-16 10:30', 'folder-9');

    expect(calls[0]!.url).toContain('https://drive.test/v3/files');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      name: 'Sermon captions 2026-08-16 10:30',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder-9'],
    });
    expect(created).toEqual({ documentId: 'doc-1', url: 'https://docs.test/1' });
  });

  it('omits parents entirely when no folder was named', async () => {
    // Sending parents: [] or [''] is not the same as leaving it out.
    const { client, calls } = harness();
    await client.createDoc('untitled');
    expect(calls[0]!.body).not.toHaveProperty('parents');
  });

  it('falls back to a document URL if Drive returns none', async () => {
    const { client } = harness([Response.json({ id: 'doc-2' })]);
    const created = await client.createDoc('x');
    expect(created.url).toBe('https://docs.google.com/document/d/doc-2/edit');
  });
});

describe('appending', () => {
  it('sends one insertText at the end of the body', async () => {
    const { client, calls } = harness([Response.json({})]);
    await client.appendText('doc-1', 'hello\n');

    expect(calls[0]!.url).toBe('https://docs.test/v1/documents/doc-1:batchUpdate');
    expect(calls[0]!.body).toEqual({
      requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text: 'hello\n' } }],
    });
  });

  it('makes no request for nothing', async () => {
    const { client, calls } = harness();
    await client.appendText('doc-1', '');
    expect(calls).toEqual([]);
  });
});

describe('telling a wall from a hiccup', () => {
  it('treats 403, 404 and 400 as permanent', async () => {
    for (const status of [400, 403, 404]) {
      expect(new GoogleDocsError('x', status).isPermanent).toBe(true);
    }
  });

  it('treats 429 and 5xx as worth retrying', async () => {
    for (const status of [429, 500, 503]) {
      expect(new GoogleDocsError('x', status).isPermanent).toBe(false);
    }
  });

  it('raises a GoogleDocsError, not a bare one, so the writer can tell', async () => {
    const { client } = harness([new Response('nope', { status: 403 })]);
    await expect(client.appendText('doc-1', 'x')).rejects.toBeInstanceOf(GoogleDocsError);
  });
});
