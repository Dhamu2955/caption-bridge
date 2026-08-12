import type { GoogleDocsClient } from '../google/docs.js';
import { GoogleDocsError } from '../google/docs.js';
import type { CaptionLine } from './types.js';
import { info, warn } from '../util/log.js';

/**
 * The service, written into a Google Doc as it happens.
 *
 * Gujarati and English in paragraphs, for somebody to read afterwards and write
 * a summary from. Not a transcript for the archive — that is what the .srt and
 * the database are for — but the thing a person actually opens on Monday.
 *
 * Paragraphs, and NOT one entry per caption, because the two consumers want
 * opposite things. A caption line is now whatever Soniox finished translating —
 * see `LineBuilder.push`, where waiting for anything longer was pure lag on the
 * screens — and that is a few words. Stamped and printed one per line with both
 * languages, a sermon came out as four lines of document per clause: technically
 * complete, unreadable, and long enough that finding a passage meant scrolling
 * past two thousand lines. So the clauses are joined back into paragraphs here,
 * where the reader is, and the screens keep their short lines.
 *
 * The contract is `LiveSrtWriter`'s, and for the same reason: this is a
 * by-product and the screens are the job. `add()` is synchronous, never throws
 * and never awaits. Every failure past that is swallowed, reported once, and
 * surfaced as state rather than left in a log nobody reads.
 */

export type DocState = 'creating' | 'writing' | 'failed';

/**
 * Where one paragraph ends and the next begins.
 *
 * `gapMs` is the one that does the work: a paragraph ends where the speaker
 * stopped for a moment, which is where a reader would put the break too. The
 * other two are ceilings, not targets — a speaker who does not pause for a
 * minute still gets paragraphs rather than a wall.
 *
 * Measured in the speaker's own timeline, from `audioStartMs`, never in arrival
 * time. A slow network must not change where the paragraphs fall.
 */
export interface ParagraphRules {
  /** Silence at least this long ends the paragraph. */
  gapMs: number;
  /** Soft ceiling on the longer of the two languages. */
  maxChars: number;
  /** Soft ceiling on how much speech one paragraph covers. */
  maxSpanMs: number;
}

export const PARAGRAPH: ParagraphRules = {
  gapMs: 1500,
  maxChars: 250,
  maxSpanMs: 20_000,
};

export interface LiveDocWriterOptions {
  client: GoogleDocsClient;
  title: string;
  /** Wall-clock time of audio position 0, for the timestamps on each entry. */
  sessionEpoch: number;
  folderId?: string | undefined;
  /** How often the buffer is sent. One request per tick, however much is in it. */
  flushIntervalMs?: number;
  /** Beyond this the oldest entries are dropped; the .srt still has them. */
  maxPendingChars?: number;
  /** Consecutive retryable failures before giving up for the rest of the service. */
  maxFailures?: number;
  paragraph?: Partial<ParagraphRules>;
  onError?: (error: Error) => void;
}

const DEFAULTS = {
  flushIntervalMs: 5000,
  maxPendingChars: 200_000,
  maxFailures: 5,
};

/** One paragraph's worth of speech, once it has been decided that it is one. */
export interface DocEntry {
  /** Position of the FIRST clause in it — what the stamp and the offset mean. */
  audioStartMs: number;
  original: string;
  translation: string;
}

/** A clause that closes a thought: Latin and Gujarati both, with any closer. */
const SENTENCE_END = /[.!?।॥…][)\]"'”’]*$/;

/** Punctuation that belongs to the word before it, not after a space. */
const LEADING_PUNCTUATION = /^[,.;:!?)\]।॥…]/;

/**
 * Clauses back into a sentence.
 *
 * A space between them, except where the next clause opens with punctuation —
 * Soniox hands back the comma of a subclause as its own run often enough that
 * joining naively produced "the temple , and the hall" all through a document.
 */
export function joinClauses(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!out) {
      out = part;
      continue;
    }
    out += LEADING_PUNCTUATION.test(part) ? part : ` ${part}`;
  }
  return out;
}

/**
 * `10:42:17  (0:12:34)` — the wall clock, then the position in the recording.
 *
 * Both, because they answer different questions. Time of day is how a person
 * places a passage against the service they sat through; the offset is how they
 * find it in the recording, and it is the same number the .srt uses.
 *
 * One stamp per paragraph rather than per clause. Seconds are kept: the stamp
 * marks where the paragraph STARTS, and rounding it to the minute would point
 * at the wrong place in a recording being scrubbed through.
 */
export function formatEntry(entry: DocEntry, epoch: number): string {
  const at = new Date(epoch + entry.audioStartMs);
  const clock = at.toTimeString().slice(0, 8);

  const total = Math.max(0, Math.floor(entry.audioStartMs / 1000));
  const offset =
    `${Math.floor(total / 3600)}:` +
    `${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:` +
    `${String(total % 60).padStart(2, '0')}`;

  // Blank line between the languages so each reads as a block of prose. One of
  // them empty — an untranslated run past `maxUntranslatedMs`, or an English
  // aside with no original — must not leave a stray blank behind.
  const body = [entry.original.trim(), entry.translation.trim()].filter(Boolean).join('\n\n');
  return `${clock}  (${offset})\n${body}\n\n`;
}

/** A paragraph still being spoken. Not written anywhere until it is closed. */
interface OpenParagraph {
  startMs: number;
  endMs: number;
  originals: string[];
  translations: string[];
}

/**
 * Local time, in both halves.
 *
 * The title mixed a UTC date with a local time, so a service starting just
 * after midnight was filed under yesterday — caught by reading a real document
 * back: created 23:16 UTC, titled "2026-08-11 00:16" when it was the 12th in
 * the room. Nobody looking for that doc on Sunday would have found it.
 *
 * Everything a person reads here is local, because they were standing in the
 * hall when it was recorded.
 */
function localStamp(at: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

export class LiveDocWriter {
  private readonly options: LiveDocWriterOptions;
  private readonly flushIntervalMs: number;
  private readonly maxPendingChars: number;
  private readonly maxFailures: number;
  private readonly paragraph: ParagraphRules;

  private documentId: string | undefined;
  private docUrl: string | undefined;
  private docState: DocState = 'creating';
  /**
   * Whole entries, never one long string.
   *
   * The string version trimmed at the first blank line past the overflow, which
   * was an entry boundary back when an entry was three lines. A paragraph has a
   * blank line INSIDE it, between the languages, so the same search would drop
   * a Gujarati paragraph and leave its English orphaned under somebody else's
   * timestamp.
   */
  private pendingEntries: string[] = [];
  private pendingChars = 0;
  /** The paragraph still being spoken, if any. */
  private open: OpenParagraph | undefined;
  /** Whether a line arrived during the tick just gone — see `closeIfIdle`. */
  private addedSinceTick = false;
  private written = 0;
  private failures = 0;
  private droppedNoted = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * The create call, awaited by every flush.
   *
   * Not awaited in the constructor — a session must not block on Google before
   * it starts captioning — but a flush that fired before the document existed
   * used to return silently, and `close()` on a short session therefore left an
   * empty document and no link. Found on the first real run: state stuck at
   * `creating`, two lines buffered, nothing written.
   */
  private readonly creating: Promise<void>;
  /** Serialised: two appends at endOfSegmentLocation can land out of order. */
  private chain: Promise<void> = Promise.resolve();

  /** `Sermon captions 2026-08-16 10:30` — sorts by date, unique per service. */
  static titleFor(at: Date): string {
    const { date, time } = localStamp(at);
    return `Sermon captions ${date} ${time}`;
  }

  constructor(options: LiveDocWriterOptions) {
    this.options = options;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxPendingChars = options.maxPendingChars ?? DEFAULTS.maxPendingChars;
    this.maxFailures = options.maxFailures ?? DEFAULTS.maxFailures;
    this.paragraph = { ...PARAGRAPH, ...options.paragraph };

    // Eagerly, and not awaited here. Creating on the first line instead would
    // mean no link to hand anybody until somebody had spoken.
    this.creating = this.create();
    this.timer = setInterval(() => {
      this.closeIfIdle();
      void this.flush();
    }, this.flushIntervalMs);
    // Nothing here should hold the process open at shutdown.
    this.timer.unref?.();
  }

  get url(): string | undefined {
    return this.docUrl;
  }

  get state(): DocState {
    return this.docState;
  }

  /** Characters waiting to be sent — a number the status endpoint can show. */
  get pending(): number {
    return this.pendingChars;
  }

  get entries(): number {
    return this.written;
  }

  private async create(): Promise<void> {
    try {
      const created = await this.options.client.createDoc(
        this.options.title,
        this.options.folderId,
      );
      this.documentId = created.documentId;
      this.docUrl = created.url;
      this.docState = 'writing';
      info(`writing the service to ${created.url}`);
    } catch (err) {
      this.fail(err as Error, 'could not create the Google Doc');
    }
  }

  /**
   * Queue one line. Synchronous, and cheap once the writer has given up.
   *
   * It joins the paragraph being spoken rather than being written straight out,
   * so nothing reaches the buffer until the paragraph has ended. What is open
   * is bounded by the ceilings in `ParagraphRules` — twenty seconds of speech
   * at most, which is what a crash mid-service would cost the document. The
   * .srt has it either way.
   */
  add(line: CaptionLine): void {
    if (this.docState === 'failed') return;

    const original = line.original.trim();
    const translation = line.translation.trim();
    if (!original && !translation) return;

    // The speaker stopped: that break is the paragraph's, not the next one's.
    if (this.open && line.audioStartMs - this.open.endMs >= this.paragraph.gapMs) {
      this.closeParagraph();
    }

    const open = (this.open ??= {
      startMs: line.audioStartMs,
      endMs: line.audioEndMs,
      originals: [],
      translations: [],
    });
    if (original) open.originals.push(original);
    if (translation) open.translations.push(translation);
    // Never backwards: a line whose end precedes the paragraph's would shorten
    // the span and hold a paragraph open past its ceiling.
    open.endMs = Math.max(open.endMs, line.audioEndMs);

    this.written++;
    this.addedSinceTick = true;
    if (this.isFull(open)) this.closeParagraph();
  }

  /**
   * Long enough — and if at all possible, finished.
   *
   * Passing the ceiling mid-sentence and cutting there would put the break in
   * the worst available place, so it runs on to the next full stop and only
   * gives up at twice the ceiling, where the speaker plainly is not going to
   * provide one. Judged on the translation, which is what the ceiling is for;
   * the original only stands in when there is no translation to read.
   */
  private isFull(open: OpenParagraph): boolean {
    const original = joinClauses(open.originals);
    const translation = joinClauses(open.translations);

    const chars = Math.max(original.length, translation.length);
    const span = open.endMs - open.startMs;
    if (chars < this.paragraph.maxChars && span < this.paragraph.maxSpanMs) return false;

    if (SENTENCE_END.test(translation || original)) return true;
    return chars >= this.paragraph.maxChars * 2 || span >= this.paragraph.maxSpanMs * 2;
  }

  /** Render the open paragraph into the buffer. Nothing if there is none. */
  private closeParagraph(): void {
    const open = this.open;
    this.open = undefined;
    if (!open) return;

    const entry = formatEntry(
      {
        audioStartMs: open.startMs,
        original: joinClauses(open.originals),
        translation: joinClauses(open.translations),
      },
      this.options.sessionEpoch,
    );
    this.pendingEntries.push(entry);
    this.pendingChars += entry.length;
    this.trim();
  }

  /**
   * Close a paragraph nobody is adding to.
   *
   * The gap rule needs a NEXT line to measure against, and the last paragraph
   * before an interval — or before the end of the sermon, with the operator not
   * yet at the Stop button — never gets one. This is that same rule in wall
   * time. A paragraph still being spoken gets a line every couple of seconds
   * and so is never idle for a whole tick, which is what stops this cutting
   * anybody off mid-sentence.
   */
  private closeIfIdle(): void {
    if (this.open && !this.addedSinceTick) this.closeParagraph();
    this.addedSinceTick = false;
  }

  private trim(): void {
    // Oldest first, whole entries only, and never the newest one. The .srt
    // still has everything, so this is the right thing to lose when the network
    // has been out for ten minutes and something has to give.
    while (this.pendingChars > this.maxPendingChars && this.pendingEntries.length > 1) {
      this.pendingChars -= this.pendingEntries.shift()!.length;
      if (!this.droppedNoted) {
        this.droppedNoted = true;
        warn('the Google Doc is behind and the oldest lines are being dropped — the .srt has them');
      }
    }
  }

  /** Send everything buffered, as one request. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushOnce());
    return this.chain;
  }

  private async flushOnce(): Promise<void> {
    // Resolved after the first time; this is what stops a flush racing the
    // create and silently doing nothing.
    await this.creating;
    if (this.docState === 'failed') return;
    if (!this.documentId || this.pendingEntries.length === 0) return;

    const batch = this.pendingEntries;
    this.pendingEntries = [];
    this.pendingChars = 0;

    try {
      await this.options.client.appendText(this.documentId, batch.join(''));
      this.failures = 0;
    } catch (err) {
      // Back to the FRONT of the buffer, before anything else is decided: a
      // transient failure must not cost the words it was carrying.
      this.pendingEntries = [...batch, ...this.pendingEntries];
      this.pendingChars = this.pendingEntries.reduce((sum, entry) => sum + entry.length, 0);
      this.trim();

      const error = err as Error;
      if (error instanceof GoogleDocsError && error.isPermanent) {
        this.fail(error, 'the Google Doc stopped accepting lines');
        return;
      }
      this.failures++;
      if (this.failures >= this.maxFailures) {
        this.fail(error, `the Google Doc failed ${this.failures} times in a row`);
      }
    }
  }

  /**
   * Give up for the rest of the service, once, loudly enough to be seen.
   *
   * The state is what matters more than the log line: finding out on Monday
   * that the doc stopped at 10:14 is the failure this is engineered against, so
   * `LiveSession` puts it on the Captions tab.
   */
  private fail(error: Error, what: string): void {
    if (this.docState === 'failed') return;
    this.docState = 'failed';
    this.pendingEntries = [];
    this.pendingChars = 0;
    this.open = undefined;
    this.stopTimer();
    warn(`${what}: ${error.message}`);
    this.options.onError?.(error);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Final flush at the end of a service. Bounded: never hang on Google. */
  async close(): Promise<void> {
    this.stopTimer();
    if (this.docState === 'failed') return;
    // The last sentence of the sermon is still an open paragraph, and it is the
    // one somebody will look for.
    this.closeParagraph();

    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
    });
    await Promise.race([this.flush(), deadline]);
  }
}
