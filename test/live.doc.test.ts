import { describe, expect, it, vi } from 'vitest';

import { GoogleDocsClient, GoogleDocsError } from '../src/google/docs.js';
import { LiveDocWriter, formatEntry, joinClauses } from '../src/live/liveDoc.js';
import type { CaptionLine } from '../src/live/types.js';

const EPOCH = Date.parse('2026-08-16T09:30:00.000Z');

const line = (
  translation: string,
  startMs = 0,
  original = 'ભક્તિ એ માર્ગ છે.',
  durationMs = 2000,
): CaptionLine => ({
  id: `l-${startMs}`,
  original,
  translation,
  audioStartMs: startMs,
  audioEndMs: startMs + durationMs,
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

/**
 * A paragraph reaches the buffer when it ENDS, so the machinery tests below —
 * which are about flushing and failing, not about where paragraphs break — say
 * so with a gap after every line. One line each, as it used to be.
 */
const PER_LINE = { paragraph: { gapMs: 1 } };

describe('the entry layout', () => {
  it('is time of day, position, Gujarati, blank, English', () => {
    const text = formatEntry(
      { audioStartMs: 754_000, original: 'આ મહિમા છે.', translation: 'This is the glory.' },
      EPOCH,
    );
    const [clock, gujarati, blank, english] = text.split('\n');

    expect(clock).toMatch(/^\d{2}:\d{2}:\d{2}  \(0:12:34\)$/);
    expect(gujarati).toBe('આ મહિમા છે.');
    // The two languages read as separate blocks of prose, not as a pair of
    // lines — which is the whole point of joining the clauses up.
    expect(blank).toBe('');
    expect(english).toBe('This is the glory.');
  });

  it('leaves no stray blank when a paragraph has only one language', () => {
    // An untranslated run past maxUntranslatedMs, or an English aside Soniox
    // never translated because it was already English.
    const text = formatEntry({ audioStartMs: 0, original: 'ફક્ત ગુજરાતી.', translation: '' }, EPOCH);
    expect(text.split('\n').slice(1)).toEqual(['ફક્ત ગુજરાતી.', '', '']);
  });

  it('counts the offset past an hour', () => {
    expect(
      formatEntry({ audioStartMs: 3_723_000, original: 'x', translation: 'y' }, EPOCH),
    ).toContain('(1:02:03)');
  });
});

describe('joining clauses back into sentences', () => {
  it('puts a space between them', () => {
    expect(joinClauses(['And then he said', 'that this life', 'is an opportunity.'])).toBe(
      'And then he said that this life is an opportunity.',
    );
  });

  it('does not put one before punctuation', () => {
    // Soniox hands back the comma of a subclause as a run of its own often
    // enough that joining naively left "the temple , and the hall" throughout.
    expect(joinClauses(['the temple', ', and the hall'])).toBe('the temple, and the hall');
  });
});

describe('where paragraphs break', () => {
  const flushed = async (lines: CaptionLine[], over: Record<string, unknown> = {}) => {
    const { client, appends } = fakeClient();
    const doc = writer(client, over);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));
    for (const line of lines) doc.add(line);
    await doc.close();
    return appends.join('');
  };

  /** Entries are `HH:MM:SS  (offset)` headed, so counting stamps counts them. */
  const stamps = (text: string) => text.match(/^\d{2}:\d{2}:\d{2}  \(/gm) ?? [];

  it('joins the clauses of one thought into a paragraph with one timestamp', async () => {
    // The whole reason this file changed: three clauses of Soniox translation
    // were three timestamps and nine lines of document.
    const text = await flushed([
      line('And then he said', 0, 'અને પછી તેમણે કહ્યું'),
      line('that this life', 2000, 'કે આ જીવન'),
      line('is an opportunity.', 4000, 'એક તક છે.'),
    ]);

    expect(stamps(text)).toHaveLength(1);
    expect(text).toContain('And then he said that this life is an opportunity.');
    expect(text).toContain('અને પછી તેમણે કહ્યું કે આ જીવન એક તક છે.');
  });

  it('starts a new paragraph where the speaker paused', async () => {
    const text = await flushed([
      line('Before the pause.', 0),
      // Two seconds of silence: past gapMs, and where a reader would break too.
      line('After it.', 4000),
    ]);

    expect(stamps(text)).toHaveLength(2);
  });

  it('breaks a speaker who never pauses, at a full stop', async () => {
    // maxSpanMs is a ceiling, not a target — but it runs on to the end of the
    // sentence rather than cutting mid-clause the instant it is passed.
    const lines = Array.from({ length: 24 }, (_, i) =>
      line(i % 4 === 3 ? `clause ${i}.` : `clause ${i}`, i * 2000),
    );
    const text = await flushed(lines);

    expect(stamps(text).length).toBeGreaterThan(1);
    for (const paragraph of text.split('\n\n')) {
      if (paragraph.includes('clause')) expect(paragraph.trimEnd().endsWith('.')).toBe(true);
    }
  });

  it('gives up on the full stop at twice the ceiling', async () => {
    // A speaker Soniox never punctuates must still not produce one endless
    // paragraph — the ceiling is soft, not absent. Two minutes of it, broken at
    // the hard limit of twice the twenty-second one.
    const lines = Array.from({ length: 60 }, (_, i) => line(`no full stop here ${i}`, i * 2000));
    const text = await flushed(lines);

    expect(stamps(text)).toHaveLength(3);
  });

  it('timestamps a paragraph where it STARTED, not where it ended', async () => {
    const text = await flushed([
      line('The start of the thought', 754_000),
      line('and the end of it.', 756_000),
    ]);

    expect(text).toContain('(0:12:34)');
  });

  it('writes nothing until a paragraph has ended', async () => {
    // The trade for readable paragraphs: up to maxSpanMs of speech is held
    // outside the buffer. The .srt has it, and the ceiling bounds the loss.
    const { client, appends } = fakeClient();
    const doc = writer(client);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('Still being said'));
    await doc.flush();
    expect(appends).toEqual([]);

    await doc.close();
    expect(appends[0]).toContain('Still being said');
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
    const doc = writer(client, PER_LINE);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    for (let i = 0; i < 10; i++) doc.add(line(`Line ${i}.`, i * 3000));
    await doc.close();

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
    await doc.close();

    expect(appends[0]).toContain('Spoken during creation.');
  });
});

describe('when Google stops answering', () => {
  it('keeps the words and retries with them', async () => {
    const { client, appends } = fakeClient([new Error('ECONNRESET')]);
    const doc = writer(client, PER_LINE);
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('Must not be lost.'));
    doc.add(line('The next thing said.', 3000));
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
    const doc = writer(client, { onError: (err: Error) => errors.push(err), ...PER_LINE });
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('First.'));
    doc.add(line('Second.', 3000));
    await doc.flush();

    expect(doc.state).toBe('failed');
    expect(errors).toHaveLength(1);

    // And every later line is a cheap no-op rather than more failures.
    doc.add(line('Third.', 6000));
    await doc.flush();
    expect(appends).toHaveLength(1);
  });

  it('gives up after enough consecutive failures', async () => {
    const { client } = fakeClient([
      new Error('down'), new Error('down'), new Error('down'),
    ]);
    const doc = writer(client, { maxFailures: 3, ...PER_LINE });
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    doc.add(line('x'));
    doc.add(line('y', 3000));
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
    const doc = writer(client, { maxPendingChars: 200, ...PER_LINE });
    await vi.waitFor(() => expect(doc.state).toBe('writing'));

    for (let i = 0; i < 50; i++) doc.add(line(`Line ${i}.`, i * 3000));
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
  it('uses the LOCAL date and time, so it is filed under the day it happened', () => {
    // Found by reading a real document back: a UTC date beside a local time put
    // a service that started at 00:16 under the previous day.
    expect(LiveDocWriter.titleFor(new Date(2026, 7, 16, 9, 30))).toBe(
      'Sermon captions 2026-08-16 09:30',
    );
    expect(LiveDocWriter.titleFor(new Date(2026, 7, 12, 0, 16))).toBe(
      'Sermon captions 2026-08-12 00:16',
    );
  });
});

describe('a session that stops almost immediately', () => {
  /**
   * Found on the first real run against Google. `close()` fired before the
   * document had finished being created, so the flush returned silently: state
   * stuck at "creating", the lines still buffered, and an empty document with
   * no link to it. A short service, or a Start pressed and stopped, lost
   * everything that was said.
   */
  it('waits for the document to exist before giving up on the flush', async () => {
    let resolveCreate: (v: { documentId: string; url: string }) => void;
    const created = new Promise<{ documentId: string; url: string }>((r) => { resolveCreate = r; });
    const appends: string[] = [];
    const client = {
      createDoc: () => created,
      appendText: async (_id: string, text: string) => { appends.push(text); },
    } as unknown as GoogleDocsClient;

    const doc = writer(client);
    doc.add(line('Said before the doc existed.'));

    // close() while creation is still in flight — the exact race.
    const closing = doc.close();
    resolveCreate!({ documentId: 'doc-9', url: 'https://docs.test/doc-9' });
    await closing;

    expect(doc.state).toBe('writing');
    expect(doc.url).toBe('https://docs.test/doc-9');
    expect(appends[0]).toContain('Said before the doc existed.');
  });
});
