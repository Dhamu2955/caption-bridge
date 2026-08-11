import { GoogleAuth, googleRequest, type MakeError } from './oauth.js';

/**
 * Creating a Google Doc and appending to it.
 *
 * Two APIs, because neither does both: Drive creates the file (Docs'
 * `documents.create` cannot put one in a folder — it lands in My Drive root and
 * needs a second call to move it), and Docs appends to it.
 *
 * Which scope is asked for is a deliberate choice, not a default — see below.
 */

/**
 * The narrow scope: files this app created, and nothing else in your Drive.
 * Enough to make a doc and write to it, and the right default for something
 * running unattended on a machine in an office.
 *
 * It is NOT enough to create into a folder you picked in Drive — Google grants
 * `drive.file` per-file, for files the app made or you handed it through a
 * picker, and there is no picker here. So a nominated folder needs the broad
 * scope, which is why that is an explicit choice rather than a surprise 403 on
 * a Sunday.
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

export function googleDocsScopes(fullDriveAccess: boolean): string[] {
  return [fullDriveAccess ? DRIVE_FULL_SCOPE : DRIVE_FILE_SCOPE];
}

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

    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // The one failure worth explaining rather than reporting. `drive.file`
      // cannot reach a folder this app did not create, and the raw message
      // says only "insufficient permissions", which sends people to the wrong
      // place entirely.
      const error = err as GoogleDocsError;
      if (folderId && (error.status === 403 || error.status === 404)) {
        throw new GoogleDocsError(
          `cannot create the doc in folder ${folderId}: ${error.message}. ` +
            'The narrow Drive permission only covers files this app made. Either clear the ' +
            'folder id to use My Drive, or set googleDocs.fullDriveAccess to true in ' +
            'config.json and run `doc --auth` again.',
          error.status,
          error.reason,
        );
      }
      throw err;
    }
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
