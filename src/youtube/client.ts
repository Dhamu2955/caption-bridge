import { setTimeout as delay } from 'node:timers/promises';

import {
  QUOTA_REASONS,
  type CaptionListResponse,
  type CaptionTrack,
  type TokenResponse,
} from './types.js';

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

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_BOUNDARY = 'caption-bridge-boundary-8f3a1c';
/** Re-mint this far before the token actually dies, so a slow upload cannot straddle expiry. */
const TOKEN_SKEW_MS = 60_000;

export class YoutubeClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly baseUrl: string;
  private readonly uploadUrl: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly boundary: string;

  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;

  constructor(options: YoutubeClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.baseUrl = (options.baseUrl ?? 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');
    this.uploadUrl = (options.uploadUrl ?? 'https://www.googleapis.com/upload/youtube/v3').replace(
      /\/+$/,
      '',
    );
    this.tokenUrl = options.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.now = options.now ?? (() => Date.now());
    this.maxRetries = options.maxRetries ?? 4;
    this.boundary = options.boundary ?? DEFAULT_BOUNDARY;
  }

  /** Cached until a minute before expiry, so a batch of uploads mints one token. */
  private async bearer(force = false): Promise<string> {
    if (!force && this.accessToken && this.now() < this.accessTokenExpiresAt - TOKEN_SKEW_MS) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new YoutubeError(
        `refreshing the access token failed: ${response.status} ${response.statusText}${detail}. ` +
          `If this says invalid_grant the refresh token has expired — set the OAuth consent screen ` +
          `to Production and re-run \`publish --auth\`.`,
        response.status,
      );
    }

    const token = (await response.json()) as TokenResponse;
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = this.now() + (token.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError: YoutubeError | undefined;
    let forceRefresh = false;
    let refreshedOnce = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));

      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.bearer(forceRefresh)}`);
      forceRefresh = false;

      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, headers });
      } catch (err) {
        lastError = new YoutubeError(`network error calling ${url}: ${(err as Error).message}`);
        continue;
      }

      if (response.ok) return response;

      const { detail, reason } = await readApiError(response);
      lastError = new YoutubeError(
        `${init.method ?? 'GET'} ${url} failed: ${response.status} ${response.statusText}${detail}`,
        response.status,
        reason,
      );

      // A token can be revoked mid-run. Re-mint ONCE and try again rather than
      // failing a backlog run on an hour boundary. A second 401 is a real
      // credentials problem and falls through to the throw below.
      if (response.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        forceRefresh = true;
        continue;
      }
      if (!RETRYABLE.has(response.status)) throw lastError;
    }
    throw lastError ?? new YoutubeError(`request to ${url} failed`);
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

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? ` — ${text.slice(0, 500)}` : '';
  } catch {
    return '';
  }
}

/** Google nests the useful part: error.errors[0].reason is what identifies a quota wall. */
async function readApiError(response: Response): Promise<{ detail: string; reason?: string }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { detail: '' };
  }
  if (!text) return { detail: '' };

  const detail = ` — ${text.slice(0, 500)}`;
  try {
    const parsed = JSON.parse(text) as {
      error?: { errors?: { reason?: string }[]; status?: string };
    };
    const reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
    return reason ? { detail, reason } : { detail };
  } catch {
    return { detail };
  }
}
