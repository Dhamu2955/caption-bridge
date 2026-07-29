import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  CreateTranscriptionRequest,
  Transcript,
  Transcription,
  UploadedFile,
} from './types.js';

export class SonioxError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SonioxError';
    this.status = status;
  }
}

export interface SonioxClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — avoids real sleeps in retry/poll loops. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface WaitOptions {
  intervalMs: number;
  timeoutMs: number;
  onProgress?: (job: Transcription, elapsedMs: number) => void;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Async (batch) client. Flow:
 *   POST /files                     upload the WAV
 *   POST /transcriptions            submit the job
 *   GET  /transcriptions/{id}       poll until completed
 *   GET  /transcriptions/{id}/transcript
 */
export class SonioxAsyncClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(options: SonioxClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.soniox.com/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.maxRetries = options.maxRetries ?? 4;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);

    let lastError: SonioxError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));

      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, headers });
      } catch (err) {
        lastError = new SonioxError(`network error calling ${path}: ${(err as Error).message}`);
        continue;
      }

      if (response.ok) return response;

      const detail = await readErrorBody(response);
      lastError = new SonioxError(
        `${init.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}${detail}`,
        response.status,
      );
      if (!RETRYABLE.has(response.status)) throw lastError;
    }
    throw lastError ?? new SonioxError(`request to ${path} failed`);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  /**
   * Streams the file from disk rather than buffering it — a 90-minute WAV is
   * ~170 MB and must never be read into memory (§4 acceptance).
   */
  async uploadFile(path: string): Promise<UploadedFile> {
    const blob = await openAsBlob(path);
    const form = new FormData();
    form.append('file', blob, basename(path));
    return this.json<UploadedFile>('/files', { method: 'POST', body: form });
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  }

  async createTranscription(request: CreateTranscriptionRequest): Promise<Transcription> {
    return this.json<Transcription>('/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  async getTranscription(id: string): Promise<Transcription> {
    return this.json<Transcription>(`/transcriptions/${encodeURIComponent(id)}`);
  }

  async deleteTranscription(id: string): Promise<void> {
    await this.request(`/transcriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** The transcript endpoint 409s until the job is completed, so poll status first. */
  async getTranscript(id: string): Promise<Transcript> {
    return this.json<Transcript>(`/transcriptions/${encodeURIComponent(id)}/transcript`);
  }

  async waitForCompletion(id: string, options: WaitOptions): Promise<Transcription> {
    const deadline = options.timeoutMs;
    let elapsed = 0;
    for (;;) {
      const job = await this.getTranscription(id);
      if (job.status === 'completed') return job;
      if (job.status === 'error') {
        throw new SonioxError(
          `transcription ${id} failed: ${job.error_type ?? 'error'} — ${job.error_message ?? 'no detail'}`,
        );
      }
      options.onProgress?.(job, elapsed);
      if (elapsed >= deadline) {
        throw new SonioxError(
          `transcription ${id} still ${job.status} after ${Math.round(elapsed / 1000)}s — giving up`,
        );
      }
      await this.sleep(options.intervalMs);
      elapsed += options.intervalMs;
    }
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
