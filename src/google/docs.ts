import { GoogleAuth, googleRequest, type MakeError } from './oauth.js';

/**
 * Creating a Google Doc and appending to it.
 *
 * Two APIs, because neither does both: Drive creates the file (Docs'
 * `documents.create` cannot put one in a folder — it lands in My Drive root and
 * needs a second call to move it), and Docs appends to it.
 *
 * `drive.file` is the narrow scope: it grants access only to files this app
 * created, which is exactly the reach wanted for something running unattended
 * on a machine in a mandir office. If creating into a nominated folder comes
 * back 403 `insufficientFilePermissions`, that is the known edge — re-mint with
 * the full `drive` scope. It is one constant.
 */

export const GOOGLE_DOCS_SCOPES = ['https://www.googleapis.com/auth/drive.file'] as const;

export class GoogleDocsError extends Error {
  readonly status: number | undefined;
  readonly reason: string | undefined;

  constructor(message: string, status?: number, reason?: string) {
    super(message);
    this.name = 'GoogleDocsError';
    this.status = status;
    this.reason = reason;
  }

  /**
   * Retrying will never help: the token is wrong, the scope is wrong, the doc
   * was deleted, or the folder is not ours. The writer stops on these rather
   * than hammering a wall for ninety minutes.
   */
  get isPermanent(): boolean {
    return this.status === 400 || this.status === 403 || this.status === 404;
  }
}

const makeError: MakeError = (message, status, reason) =>
  new GoogleDocsError(message, status, reason);

export interface GoogleDocsClientOptions {
  auth: GoogleAuth;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  docsBaseUrl?: string;
  driveBaseUrl?: string;
}

export interface CreatedDoc {
  documentId: string;
  /** The link a human opens. Worth surfacing the moment it exists. */
  url: string;
}

export class GoogleDocsClient {
  private readonly options: GoogleDocsClientOptions;
  private readonly docsBaseUrl: string;
  private readonly driveBaseUrl: string;

  constructor(options: GoogleDocsClientOptions) {
    this.options = options;
    this.docsBaseUrl = (options.docsBaseUrl ?? 'https://docs.googleapis.com/v1').replace(/\/+$/, '');
    this.driveBaseUrl = (options.driveBaseUrl ?? 'https://www.googleapis.com/drive/v3').replace(
      /\/+$/,
      '',
    );
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return googleRequest(url, init, {
      auth: this.options.auth,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.maxRetries !== undefined ? { maxRetries: this.options.maxRetries } : {}),
      makeError,
    });
  }

  /** `folderId` empty puts it in My Drive root. */
  async createDoc(title: string, folderId?: string | undefined): Promise<CreatedDoc> {
    const url = `${this.driveBaseUrl}/files?fields=id,webViewLink&supportsAllDrives=true`;
    const body: Record<string, unknown> = {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
    };
    if (folderId) body['parents'] = [folderId];

    const response = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const created = (await response.json()) as { id?: string; webViewLink?: string };
    if (!created.id) throw new GoogleDocsError('Drive created a file with no id');

    return {
      documentId: created.id,
      url: created.webViewLink ?? `https://docs.google.com/document/d/${created.id}/edit`,
    };
  }

  /**
   * Append to the end of the document body.
   *
   * `endOfSegmentLocation` rather than an index, deliberately. Character
   * indices would let this style the text — bold the timestamps, grey the
   * Gujarati — but they have to be tracked across the whole service, and one
   * failed batch puts every later index out by the length of what did not
   * land. The layout wanted here is achievable with newlines, and plain text
   * that is always right beats formatted text that silently drifts.
   */
  async appendText(documentId: string, text: string): Promise<void> {
    if (text === '') return;
    const url = `${this.docsBaseUrl}/documents/${encodeURIComponent(documentId)}:batchUpdate`;
    await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }],
      }),
    });
  }
}
