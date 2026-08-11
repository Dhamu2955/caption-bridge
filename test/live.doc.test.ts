import { describe, expect, it, vi } from 'vitest';

import { GoogleDocsClient, GoogleDocsError } from '../src/google/docs.js';
import { LiveDocWriter, formatEntry } from '../src/live/liveDoc.js';
import type { CaptionLine } from '../src/live/types.js';

const EPOCH = Date.parse('2026-08-16T09:30:00.000Z');

const line = (translation: string, startMs = 0, original = 'ભક્તિ એ માર્ગ છે.'): CaptionLine => ({
  id: `l-${startMs}`,
  original,
  translation,
  audioStartMs: startMs,
  audioEndMs: startMs + 2000,
  speaker: '1',
});

/** A client that records what was asked of it and answers however told. */
function fakeClient(appendResults: (Error | null)[] = []) {
  const appends: string[] = [];
  let at = 0;
  const client = {
    createDoc: async () => ({ documentId: 'doc-1', url: 'https://docs.test/doc-1' }),
    appendText: async (_id: string, text: string) => {
      appends.push(text);
      const next = appendResults[at++];
      if (next) throw next;
    },
  } as unknown as GoogleDocsClient;
  return { client, appends };
}

function writer(client: GoogleDocsClient, over: Record<string, unknown> = {}) {
  return new LiveDocWriter({
    client,
    title: 'test',
    sessionEpoch: EPOCH,
    flushIntervalMs: 3_600_000, // flushed by hand in tests
    onError: () => {},
    ...over,
  });
}

describe('the entry layout', () => {
  it('is time of day, position, Gujarati, English, blank', () => {
    const text = formatEntry(line('This is the glory.', 754_000, 'આ મહિમા છે.'), EPOCH);
    const [clock, gujarati, english, blank] = text.split('\n');

    expect(clock).toMatch(/^\d{2}:\d{2}:\d{2}  \(0:12:34\)$/);
    expect(gujarati).toBe('આ મહિમા છે.');
    expect(english).toBe('This is the glory.');
    expect(blank).toBe('');
  });

  it('counts the offset past an hour', () => {
    expect(formatEntry(line('x', 3_723_000), EPOCH)).toContain('(1:02:03)');
  });
});

describe('writing as the service runs', () => {
  it('creates the doc before anybody has spoken', async () => {
    // Otherwise there is no link to hand anybody until the first sentence.
    const { client } = fakeClient();
    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));
    expect(doc.url).toBe('https://docs.test/doc-1');
  });

  it('sends a whole interval of lines as ONE request', async () => {
    // The reason for batching: a per-line write would scale with how fast the
    // speaker talks, and a sermon is ninety minutes of talking.
    const { client, appends } = fakeClient();
    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    for (let i = 0; i < 10; i++) doc.add(line(`Line ${i}.`, i * 2000));
    await doc.flush();

    expect(appends).toHaveLength(1);
    expect(appends[0]).toContain('Line 0.');
    expect(appends[0]).toContain('Line 9.');
  });

  it('makes no request at all when nobody has spoken', async () => {
    const { client, appends } = fakeClient();
    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    await doc.flush();
    expect(appends).toEqual([]);
  });

  it('buffers lines that arrive before the doc exists', async () => {
    const { client, appends } = fakeClient();
    const doc = writer(client);

    doc.add(line('Spoken during creation.'));
    await vi.waitFor(() => expect(doc.state).toBe('writing'));
    await doc.flush();

    expect(appends[0]).toContain('Spoken during creation.');
  });
});

describe('when Google stops answering', () => {
  it('keeps the words and retries with them', async () => {
    const { client, appends } = fakeClient([new Error('ECONNRESET')]);
    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('Must not be lost.'));
    await doc.flush();
    expect(doc.state).toBe('writing');

    await doc.flush();
    expect(appends).toHaveLength(2);
    expect(appends[1]).toContain('Must not be lost.');
  });

  it('stops for good on a permanent failure, and says so once', async () => {
    // A revoked token, a deleted doc, a folder that is not ours. Retrying a
    // 403 for the rest of a ninety-minute service helps nobody.
    const errors: Error[] = [];
    const { client, appends } = fakeClient([new GoogleDocsError('no', 403, 'forbidden')]);
    const doc = writer(client, { onError: (err: Error) => errors.push(err) });
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('First.'));
    await doc.flush();

    expect(doc.state).toBe('failed');
    expect(errors).toHaveLength(1);

    // And every later line is a cheap no-op rather than more failures.
    doc.add(line('Second.'));
    await doc.flush();
    expect(appends).toHaveLength(1);
  });

  it('gives up after enough consecutive failures', async () => {
    const { client } = fakeClient([
      new Error('down'), new Error('down'), new Error('down'),
    ]);
    const doc = writer(client, { maxFailures: 3 });
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('x'));
    await doc.flush();
    await doc.flush();
    await doc.flush();

    expect(doc.state).toBe('failed');
  });

  it('never lets a creation failure stop the service', async () => {
    const client = {
      createDoc: async () => {
        throw new GoogleDocsError('no such folder', 404);
      },
      appendText: async () => {},
    } as unknown as GoogleDocsClient;

    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('failed'));
    expect(() => doc.add(line('The service carries on.'))).not.toThrow();
  });

  it('drops the oldest lines rather than growing without limit', async () => {
    // Ten minutes of dead network. Memory is bounded and the .srt has it all.
    const { client } = fakeClient();
    const doc = writer(client, { maxPendingChars: 200 });
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    for (let i = 0; i < 50; i++) doc.add(line(`Line ${i}.`, i * 2000));
    expect(doc.pending).toBeLessThanOrEqual(300);
  });
});

describe('closing', () => {
  it('flushes what is left', async () => {
    const { client, appends } = fakeClient();
    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('The last thing said.'));
    await doc.close();

    expect(appends[0]).toContain('The last thing said.');
  });
});

describe('the title', () => {
  it('sorts by date and cannot collide with the last service', () => {
    expect(LiveDocWriter.titleFor(new Date('2026-08-16T09:30:00Z'))).toMatch(
      /^Sermon captions 2026-08-16 \d{2}:\d{2}$/,
    );
  });
});
