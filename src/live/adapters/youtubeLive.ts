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
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
}

/** `2026-08-02T18:30:00.000` — UTC, no zone suffix, which is what the endpoint wants. */
export function formatCaptionTimestamp(at: number): string {
  return new Date(at).toISOString().replace('Z', '');
}

export class YoutubeLiveAdapter implements OutputAdapter {
  readonly name: string;
  private readonly ingestionUrl: string;
  private readonly sessionEpoch: number;
  private readonly streamOffsetMs: number;
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
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError;
  }

  /** Exposed so a test can pin the arithmetic without going through fetch. */
  timestampFor(line: CaptionLine): string {
    return formatCaptionTimestamp(this.sessionEpoch + line.audioStartMs + this.streamOffsetMs);
  }

  private url(): string {
    const separator = this.ingestionUrl.includes('?') ? '&' : '?';
    return `${this.ingestionUrl}${separator}seq=${++this.sequence}`;
  }

  show(line: CaptionLine): Promise<void> {
    // English only: the endpoint carries one track, and the Gujarati speakers
    // in the audience are listening rather than reading.
    const body = `${this.timestampFor(line)}\n${line.translation}\n`;

    this.queue = this.queue.then(async () => {
      try {
        const response = await this.fetchImpl(this.url(), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body,
        });
        if (!response.ok) {
          throw new Error(`YouTube caption POST failed: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        // A caption that does not land must never take the broadcast with it.
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
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
