import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import type { TokenResponse as AccessTokenResponse } from './oauth.js';

/** The consent exchange also returns a refresh token; the runtime one does not. */
interface TokenResponse extends AccessTokenResponse {
  refresh_token?: string;
}

/**
 * One-off refresh-token mint for `publish --auth`.
 *
 * A loopback redirect rather than a device flow, because it needs no extra
 * client type and runs on the machine the operator is already sitting at.
 *
 * The trap this exists to document: while the OAuth consent screen is in
 * "Testing" status, Google expires refresh tokens after SEVEN DAYS — exactly
 * the length of festival week. Set the app to Production. Verification is not
 * required for personal use; an unverified production app just shows a warning
 * on this one consent screen and is capped at 100 users.
 */

/**
 * What the consent screen is asked for. A parameter rather than a constant
 * because there are two credentials now — captions on a channel, and a Google
 * Doc — and they must not be granted the same scopes.
 */

export interface AuthOptions {
  clientId: string;
  clientSecret: string;
  port: number;
  /** Space-separated, as Google wants it. */
  scope: string;
  tokenUrl?: string;
  authUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called with the consent URL so the caller decides how to surface it. */
  onUrl: (url: string) => void;
}

export function buildConsentUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  authUrl?: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: options.scope,
    // Both are required to get a refresh token back: offline asks for one, and
    // consent forces a fresh one even if this client was authorised before.
    access_type: 'offline',
    prompt: 'consent',
    state: options.state,
  });
  return `${options.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth'}?${params}`;
}

export async function exchangeCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  const impl = options.fetchImpl ?? fetch;
  const response = await impl(options.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) {
    throw new Error(`exchanging the authorisation code failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>caption-bridge</title>
<body style="font-family:system-ui;padding:3rem;max-width:32rem">
<h1>Authorised</h1><p>The refresh token has been printed in the terminal. Paste it into
<code>.env</code> and close this tab.</p></body>`;

/** Runs the loopback dance and resolves with the refresh token. */
export async function authorise(options: AuthOptions): Promise<string> {
  const redirectUri = `http://127.0.0.1:${options.port}`;
  const state = randomBytes(16).toString('hex');

  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      // A mismatched state means this callback is not the one we started.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400).end('state mismatch');
        return;
      }
      if (error || !code) {
        res.writeHead(400).end(`authorisation failed: ${error ?? 'no code returned'}`);
        server.close();
        reject(new Error(`authorisation failed: ${error ?? 'no code returned'}`));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
      exchangeCode({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        code,
        redirectUri,
        ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
        .then((token) => {
          server.close();
          if (!token.refresh_token) {
            reject(
              new Error(
                'Google returned no refresh token. Revoke the app at ' +
                  'myaccount.google.com/permissions and run --auth again.',
              ),
            );
            return;
          }
          resolve(token.refresh_token);
        })
        .catch((err: unknown) => {
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    server.on('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      options.onUrl(
        buildConsentUrl({
          clientId: options.clientId,
          redirectUri,
          state,
          scope: options.scope,
          ...(options.authUrl ? { authUrl: options.authUrl } : {}),
        }),
      );
    });
  });
}
