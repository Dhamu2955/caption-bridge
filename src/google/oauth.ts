/**
 * Talking to a Google API with a refresh token.
 *
 * Lifted verbatim out of `YoutubeClient`, where it sat as two private methods
 * for a year. Nothing in it was ever YouTube-specific — the token exchange is
 * the same three fields for every Google API, the retry policy is the same
 * set of status codes, and the error envelope (`error.errors[0].reason`) is
 * the one Docs and Drive use too. It only lived there because there was
 * nothing else asking.
 *
 * House style, and the reason there is no `googleapis` dependency anywhere:
 * native fetch, everything injectable, and a caller that can be tested without
 * a network. See the header of `youtube/client.ts`.
 */

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Retried with backoff. Everything else is a real failure and throws. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Re-mint this far before the token dies, so a slow call cannot straddle expiry. */
const TOKEN_SKEW_MS = 60_000;

export type MakeError = (message: string, status?: number, reason?: string) => Error;

const defaultError: MakeError = (message) => new Error(message);

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
  /**
   * The command that re-mints THIS token, quoted in the `invalid_grant`
   * message. A parameter rather than a constant because two credentials now
   * exist and telling somebody to re-run the wrong one costs an afternoon.
   */
  reauthCommand: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  makeError?: MakeError;
}

export class GoogleAuth {
  private readonly options: GoogleAuthOptions;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly makeError: MakeError;

  private accessToken: string | undefined;
  private expiresAt = 0;

  constructor(options: GoogleAuthOptions) {
    this.options = options;
    this.tokenUrl = options.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.makeError = options.makeError ?? defaultError;
  }

  /** Cached until a minute before expiry, so a batch of calls mints one token. */
  async token(force = false): Promise<string> {
    if (!force && this.accessToken && this.now() < this.expiresAt - TOKEN_SKEW_MS) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const { detail } = await readApiError(response);
      throw this.makeError(
        `refreshing the access token failed: ${response.status} ${response.statusText}${detail}. ` +
          `If this says invalid_grant the refresh token has expired — set the OAuth consent screen ` +
          `to Production and re-run \`${this.options.reauthCommand}\`.`,
        response.status,
      );
    }

    const token = (await response.json()) as TokenResponse;
    this.accessToken = token.access_token;
    this.expiresAt = this.now() + (token.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

export interface GoogleRequestOptions {
  auth: GoogleAuth;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  makeError?: MakeError;
}

/**
 * One authenticated call, with backoff and a single forced re-mint on 401.
 *
 * The 401 handling is the part worth keeping: a token can be revoked mid-run,
 * and failing a backlog on an hour boundary because of it would be absurd. A
 * *second* 401 is a real credentials problem and throws.
 */
export async function googleRequest(
  url: string,
  init: RequestInit,
  options: GoogleRequestOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 4;
  const makeError = options.makeError ?? defaultError;

  let lastError: Error | undefined;
  let forceRefresh = false;
  let refreshedOnce = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await options.auth.token(forceRefresh)}`);
    forceRefresh = false;

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers });
    } catch (err) {
      lastError = makeError(`network error calling ${url}: ${(err as Error).message}`);
      continue;
    }

    if (response.ok) return response;

    const { detail, reason } = await readApiError(response);
    lastError = makeError(
      `${init.method ?? 'GET'} ${url} failed: ${response.status} ${response.statusText}${detail}`,
      response.status,
      reason,
    );

    if (response.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      forceRefresh = true;
      continue;
    }
    if (!RETRYABLE.has(response.status)) throw lastError;
  }
  throw lastError ?? makeError(`request to ${url} failed`);
}

/**
 * Google's error envelope, which every one of its APIs shares.
 *
 * Truncated: an HTML error page from a proxy would otherwise fill the log with
 * markup, and the first 500 characters always contain the part worth reading.
 */
export async function readApiError(
  response: Response,
): Promise<{ detail: string; reason?: string }> {
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
