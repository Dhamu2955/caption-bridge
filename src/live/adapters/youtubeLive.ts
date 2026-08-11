import type { CaptionLine, OutputAdapter } from '../types.js';

/**
 * YouTube live closed captions.
 *
 * YouTube's live caption ingestion is an HTTP POST endpoint: enable closed
 * captions with the "POST captions to URL" method on the stream and YouTube
 * hands back an ingestion URL. Each POST carries a sequence number and a UTC
 * timestamp saying where in the stream's timeline the text belongs.
 *
 * Why this output is worth having: closed captions are never burned into
 * pixels, so the whole two-composite arrangement INVARIANT 8 describes is
 * unnecessary here. A reviewer's drop simply means the POST never happens.
 *
 * THE TIMESTAMP IS THE PART TO GET RIGHT. It is not when the words were
 * spoken, it is when they appear in the stream YouTube is receiving — so it
 * carries `streamOffsetMs`, the delay sitting between the encoder and YouTube.
 * Calibrate it on a private test stream before a festival; the format and
 * sequence semantics are the one thing in this file not verifiable from the
 * codebase, which is exactly why the transport is injected.
 */

export interface YoutubeLiveAdapterOptions {
  name?: string;
  /** The ingestion URL from YouTube, including its cid parameter. */
  ingestionUrl: string;
  /** Wall-clock time corresponding to audio position 0 (INVARIANT 9). */
  sessionEpoch: number;
  /** Delay between this machine's encoder and YouTube receiving the video. */
  streamOffsetMs?: number;
  /**
   * Which clock the caption's timestamp comes from.
   *
   * `speech` (the default, and what this always did) stamps the instant the
   * words were spoken, plus `streamOffsetMs`. Correct when the video is delayed
   * to match the pipeline, and it has to be: a caption posted fifteen seconds
   * after the words, carrying the words' own timestamp, lands at a point
   * YouTube streamed past long ago.
   *
   * `now` stamps the moment of the POST. It only makes sense with the delays
   * turned down — but then it is self-correcting, because the caption is placed
   * wherever the stream has actually got to, and there is no offset to
   * calibrate and no video delay to match. This is what a working prototype of
   * this same job does, over twelve thousand accepted POSTs, with no timing
   * configuration at all.
   */
  timestampMode?: 'speech' | 'now';
  /** Injected in tests so retries do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** The wall clock, injected so `now` mode is testable without real time. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
}

/**
 * YouTube's own retry policy: randomised backoff with the ceiling doubling.
 * Four attempts, the first immediate.
 *
 * There was none of this before — one POST, and a transient failure took that
 * caption off the broadcast silently. A working prototype of this job logged
 * 275 failures against 12,473 accepted posts over a few services, so it is not
 * a rare path.
 */
const RETRY_CEILINGS_MS = [0, 100, 200, 400] as const;

/**
 * Positioning, appended to the timestamp line.
 *
 * Both this and a bare timestamp are accepted — the prototype's early runs used
 * a bare one and they succeeded too — but this is the variant with ten thousand
 * accepted posts behind it, and the wire format is the one part of this file
 * that cannot be checked from the code.
 */
const CUE_REGION = 'region:reg1#cue1';

/** `2026-08-02T18:30:00.000` — UTC, no zone suffix, which is what the endpoint wants. */
export function formatCaptionTimestamp(at: number): string {
  return new Date(at).toISOString().replace('Z', '');
}

export interface IngestionUrlCheck {
  ok: boolean;
  /** Fatal — the URL cannot be used at all. */
  error?: string;
  /** Usable, but probably not what the operator meant to paste. */
  warnings: string[];
}

/**
 * Sanity-check an ingestion URL before a service rather than during one.
 *
 * Deliberately lenient about everything except being a URL: the wire format is
 * the one part of this path not verifiable from the codebase, so guessing at
 * what a valid `cid` looks like would reject working URLs. Anything doubtful is
 * a warning, never a refusal.
 */
export function checkIngestionUrl(raw: string): IngestionUrlCheck {
  const warnings: string[] = [];
  const trimmed = raw.trim();

  if (trimmed === '') return { ok: false, error: 'the ingestion URL is empty', warnings };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: `not a URL: ${trimmed}`, warnings };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `the ingestion URL must be http or https, got ${url.protocol}`, warnings };
  }
  if (url.protocol === 'http:') {
    warnings.push('the URL is http, not https — captions would go out in the clear');
  }
  // YouTube hands back a URL carrying a cid parameter; without one the endpoint
  // has no way to tell which stream the captions belong to.
  if (!url.searchParams.has('cid')) {
    warnings.push('no "cid" parameter — check you copied the whole URL from the stream settings');
  }
  if (url.searchParams.has('seq')) {
    warnings.push('the URL already carries a "seq" parameter; the bridge appends its own');
  }

  return { ok: true, warnings };
}

export class YoutubeLiveAdapter implements OutputAdapter {
  readonly name: string;
  private readonly ingestionUrl: string;
  private sessionEpoch: number;
  private readonly streamOffsetMs: number;
  private readonly timestampMode: 'speech' | 'now';
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: ((error: Error) => void) | undefined;
  private sequence = 0;
  /** Serialised: sequence numbers are only meaningful in order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: YoutubeLiveAdapterOptions) {
    this.name = options.name ?? 'youtube';
    this.ingestionUrl = options.ingestionUrl;
    this.sessionEpoch = options.sessionEpoch;

    this.streamOffsetMs = options.streamOffsetMs ?? 0;
    this.timestampMode = options.timestampMode ?? 'speech';
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError;
  }

  /** Match the queue's clock; see `CaptionQueue.rebase`. Before anything is sent. */
  rebase(sessionEpoch: number): void {
    this.sessionEpoch = sessionEpoch;
  }

  /** Exposed so a test can pin the arithmetic without going through fetch. */
  timestampFor(line: CaptionLine, now: number = this.now()): string {
    if (this.timestampMode === 'now') return formatCaptionTimestamp(now);
    return formatCaptionTimestamp(this.sessionEpoch + line.audioStartMs + this.streamOffsetMs);
  }

  private url(sequence: number): string {
    const separator = this.ingestionUrl.includes('?') ? '&' : '?';
    return `${this.ingestionUrl}${separator}seq=${sequence}`;
  }

  show(line: CaptionLine): Promise<void> {
    this.queue = this.queue.then(async () => {
      // The sequence number is only spent by a POST YouTube actually accepted.
      // Incrementing before the request meant a failed one burned a number and
      // left a gap in the series the endpoint is counting on.
      const sequence = this.sequence + 1;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < RETRY_CEILINGS_MS.length; attempt++) {
        const ceiling = RETRY_CEILINGS_MS[attempt]!;
        if (ceiling > 0) await this.sleep(Math.random() * ceiling);

        // Re-stamped per attempt, not once before the loop. In `now` mode a
        // retry that carried the first attempt's timestamp would place the
        // caption where the stream was before the backoff, which is the one
        // thing this mode exists to get right.
        // English only: the endpoint carries one track, and the Gujarati
        // speakers in the audience are listening rather than reading.
        const body = `${this.timestampFor(line)} ${CUE_REGION}\n${line.translation}\n`;

        try {
          const response = await this.fetchImpl(this.url(sequence), {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body,
          });
          if (!response.ok) {
            throw new Error(
              `YouTube caption POST failed: ${response.status} ${response.statusText}`,
            );
          }
          this.sequence = sequence;
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }

      // A caption that does not land must never take the broadcast with it.
      if (lastError) this.onError?.(lastError);
    });
    return this.queue;
  }

  /**
   * No-op. Closed captions are not an overlay to blank — YouTube retires a cue
   * when the next one arrives, and posting an empty line would put a blank
   * caption on air rather than removing one.
   */
  clear(): void {}
}
