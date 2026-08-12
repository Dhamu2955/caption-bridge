import { setTimeout as delay } from 'node:timers/promises';

import {
  QUOTA_REASONS,
  type CaptionListResponse,
  type CaptionTrack,
} from './types.js';
import { GoogleAuth, googleRequest } from '../google/oauth.js';

/**
 * YouTube Data API v3 — caption tracks only.
 *
 * Deliberately shaped like src/soniox/asyncClient.ts: native fetch, no SDK, no
 * googleapis dependency, everything injectable. The one thing Soniox has no
 * precedent for is OAuth: the bearer here is minted from a refresh token and
 * expires hourly, so `request` awaits a token hook instead of setting a static
 * header.
 *
 * captions.insert only works on videos the authenticated channel owns. There is
 * no API path to caption someone else's video — community captions were removed
 * in 2020 — so ripped sermons are served by the projector, never by this.
 */

export class YoutubeError extends Error {
  readonly status: number | undefined;
  /** Google's errors[0].reason. `quotaExceeded` is the one bulk mode acts on. */
  readonly reason: string | undefined;

  constructor(message: string, status?: number, reason?: string) {
    super(message);
    this.name = 'YoutubeError';
    this.status = status;
    this.reason = reason;
  }

  /** True when the day's quota is spent and the only fix is waiting. */
  get isQuotaExhausted(): boolean {
    return this.reason !== undefined && QUOTA_REASONS.has(this.reason);
  }
}

export interface YoutubeClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  baseUrl?: string;
  uploadUrl?: string;
  tokenUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — avoids real sleeps in retry loops. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests — drives access-token expiry. */
  now?: () => number;
  maxRetries?: number;
  /** Fixed so a test can assert the request body byte for byte. */
  boundary?: string;
}

/** The one scope captions need: reading and writing tracks on your own channel. */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const DEFAULT_BOUNDARY = 'caption-bridge-boundary-8f3a1c';

export class YoutubeClient {
  private readonly auth: GoogleAuth;
  private readonly baseUrl: string;
  private readonly uploadUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly boundary: string;

  constructor(options: YoutubeClientOptions) {
    this.auth = new GoogleAuth({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: options.refreshToken,
      ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
      reauthCommand: 'publish --auth',
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
      makeError: (message, status, reason) => new YoutubeError(message, status, reason),
    });
    this.baseUrl = (options.baseUrl ?? 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');
    this.uploadUrl = (options.uploadUrl ?? 'https://www.googleapis.com/upload/youtube/v3').replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.maxRetries = options.maxRetries ?? 4;
    this.boundary = options.boundary ?? DEFAULT_BOUNDARY;
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return googleRequest(url, init, {
      auth: this.auth,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      maxRetries: this.maxRetries,
      makeError: (message, status, reason) => new YoutubeError(message, status, reason),
    });
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.request(url, init);
    return (await response.json()) as T;
  }

  /**
   * multipart/related, built by hand.
   *
   * `uploadType=multipart` wants multipart/related, which FormData cannot
   * produce — it emits multipart/form-data, and Google rejects it. Bodies are
   * Buffers so a Gujarati SRT is measured in bytes, not UTF-16 code units.
   */
  buildMultipartBody(metadata: unknown, srt: string): Buffer {
    if (srt.includes(this.boundary)) {
      throw new YoutubeError('the caption text contains the multipart boundary — cannot upload');
    }
    return Buffer.concat([
      Buffer.from(
        `--${this.boundary}\r\n` +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          `${JSON.stringify(metadata)}\r\n` +
          `--${this.boundary}\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      ),
      Buffer.from(srt, 'utf8'),
      Buffer.from(`\r\n--${this.boundary}--\r\n`, 'utf8'),
    ]);
  }

  private uploadInit(method: 'POST' | 'PUT', metadata: unknown, srt: string): RequestInit {
    return {
      method,
      headers: { 'Content-Type': `multipart/related; boundary=${this.boundary}` },
      body: this.buildMultipartBody(metadata, srt) as unknown as RequestInit['body'],
    };
  }

  /** 50 units. Also the self-healing path — finds tracks uploaded before this tool existed. */
  async listCaptions(videoId: string): Promise<CaptionTrack[]> {
    const url = `${this.baseUrl}/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`;
    const body = await this.json<CaptionListResponse>(url);
    return body.items ?? [];
  }

  /** 400 units. */
  async insertCaption(
    videoId: string,
    language: string,
    name: string,
    srt: string,
  ): Promise<CaptionTrack> {
    const url = `${this.uploadUrl}/captions?part=snippet&uploadType=multipart`;
    const metadata = { snippet: { videoId, language, name, isDraft: false } };
    return this.json<CaptionTrack>(url, this.uploadInit('POST', metadata, srt));
  }

  /** 450 units. Replaces the track's content in place, so viewers keep one track per language. */
  async updateCaption(trackId: string, srt: string): Promise<CaptionTrack> {
    const url = `${this.uploadUrl}/captions?part=snippet&uploadType=multipart`;
    return this.json<CaptionTrack>(url, this.uploadInit('PUT', { id: trackId }, srt));
  }

  async deleteCaption(trackId: string): Promise<void> {
    const url = `${this.baseUrl}/captions?id=${encodeURIComponent(trackId)}`;
    await this.request(url, { method: 'DELETE' });
  }
}
