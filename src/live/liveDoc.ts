import type { GoogleDocsClient } from '../google/docs.js';
import { GoogleDocsError } from '../google/docs.js';
import type { CaptionLine } from './types.js';
import { info, warn } from '../util/log.js';

/**
 * The service, written into a Google Doc as it happens.
 *
 * Gujarati and English line by line, for somebody to read afterwards and write
 * a summary from. Not a transcript for the archive — that is what the .srt and
 * the database are for — but the thing a person actually opens on Monday.
 *
 * The contract is `LiveSrtWriter`'s, and for the same reason: this is a
 * by-product and the screens are the job. `add()` is synchronous, never throws
 * and never awaits. Every failure past that is swallowed, reported once, and
 * surfaced as state rather than left in a log nobody reads.
 */

export type DocState = 'creating' | 'writing' | 'failed';

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
  onError?: (error: Error) => void;
}

const DEFAULTS = {
  flushIntervalMs: 5000,
  maxPendingChars: 200_000,
  maxFailures: 5,
};

/**
 * `10:42:17  (0:12:34)` — the wall clock, then the position in the recording.
 *
 * Both, because they answer different questions. Time of day is how a person
 * places a passage against the service they sat through; the offset is how they
 * find it in the recording, and it is the same number the .srt uses.
 */
export function formatEntry(line: CaptionLine, epoch: number): string {
  const at = new Date(epoch + line.audioStartMs);
  const clock = at.toTimeString().slice(0, 8);

  const total = Math.max(0, Math.floor(line.audioStartMs / 1000));
  const offset =
    `${Math.floor(total / 3600)}:` +
    `${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:` +
    `${String(total % 60).padStart(2, '0')}`;

  const original = line.original.trim();
  const translation = line.translation.trim();
  return `${clock}  (${offset})\n${original}\n${translation}\n\n`;
}

export class LiveDocWriter {
  private readonly options: LiveDocWriterOptions;
  private readonly flushIntervalMs: number;
  private readonly maxPendingChars: number;
  private readonly maxFailures: number;

  private documentId: string | undefined;
  private docUrl: string | undefined;
  private docState: DocState = 'creating';
  private pendingText = '';
  private written = 0;
  private failures = 0;
  private droppedNoted = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Serialised: two appends at endOfSegmentLocation can land out of order. */
  private chain: Promise<void> = Promise.resolve();

  /** `Sermon captions 2026-08-16 10:30` — sorts by date, unique per service. */
  static titleFor(at: Date): string {
    const date = at.toISOString().slice(0, 10);
    const time = at.toTimeString().slice(0, 5);
    return `Sermon captions ${date} ${time}`;
  }

  constructor(options: LiveDocWriterOptions) {
    this.options = options;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxPendingChars = options.maxPendingChars ?? DEFAULTS.maxPendingChars;
    this.maxFailures = options.maxFailures ?? DEFAULTS.maxFailures;

    // Eagerly, and not awaited. Creating on the first line instead would mean
    // no link to hand anybody until somebody had spoken.
    void this.create();
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
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
    return this.pendingText.length;
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
   */
  add(line: CaptionLine): void {
    if (this.docState === 'failed') return;
    if (!line.translation.trim() && !line.original.trim()) return;

    this.pendingText += formatEntry(line, this.options.sessionEpoch);
    this.written++;
    this.trim();
  }

  private trim(): void {
    const overflow = this.pendingText.length - this.maxPendingChars;
    if (overflow <= 0) return;

    // Oldest first, on an entry boundary. The .srt still has everything, so
    // this is the right thing to lose when the network has been out for ten
    // minutes and something has to give.
    const cut = this.pendingText.indexOf('\n\n', overflow);
    this.pendingText = cut === -1 ? '' : this.pendingText.slice(cut + 2);
    if (!this.droppedNoted) {
      this.droppedNoted = true;
      warn('the Google Doc is behind and the oldest lines are being dropped — the .srt has them');
    }
  }

  /** Send everything buffered, as one request. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushOnce());
    return this.chain;
  }

  private async flushOnce(): Promise<void> {
    if (this.docState === 'failed') return;
    if (!this.documentId || this.pendingText === '') return;

    const text = this.pendingText;
    this.pendingText = '';

    try {
      await this.options.client.appendText(this.documentId, text);
      this.failures = 0;
    } catch (err) {
      // Back to the FRONT of the buffer, before anything else is decided: a
      // transient failure must not cost the words it was carrying.
      this.pendingText = text + this.pendingText;
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
    this.pendingText = '';
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

    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
    });
    await Promise.race([this.flush(), deadline]);
  }
}
