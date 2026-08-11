import { createWriteStream, type WriteStream } from 'node:fs';
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import type { SonioxContext, SonioxToken } from '../../soniox/types.js';
import { INCLUDE_NON_FINAL } from '../types.js';

/**
 * Soniox real-time WebSocket client.
 *
 * Verified against the API reference: wss://stt-rt.soniox.com/transcribe-websocket,
 * a JSON config frame first, then raw binary audio, an empty frame to finish.
 */

export const REALTIME_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

export interface RealtimeConfig {
  apiKey: string;
  model: string;
  sampleRate: number;
  languageHints: string[];
  /** Restrict to those hints rather than treating them as suggestions. */
  languageHintsStrict?: boolean;
  targetLanguage: string;
  enableSpeakerDiarization?: boolean;
  /**
   * Glossary and register instructions. Sent at connect and only at connect —
   * Soniox has no mid-session context API — so a term added while a service is
   * running takes effect on the next start.
   */
  context?: SonioxContext | undefined;
  /** -1 patient to 1 eager; how readily Soniox calls a clause finished. */
  endpointSensitivity?: number;
  /** Ceiling on that wait, for a speaker who does not pause. */
  maxEndpointDelayMs?: number;
  /**
   * Ask for provisional tokens as well as final ones.
   *
   * INVARIANT 4 keeps these off every audience-facing pop-on output, and the
   * line builder discards them regardless of this flag — they cannot reach
   * `venue`, `stream` or the YouTube captions by any route. The only consumer
   * is the `raw` passthrough overlay, which is opt-in and exists to render
   * exactly this. Defaults to INCLUDE_NON_FINAL, which is false.
   */
  includeNonFinal?: boolean;
  /** JSONL of every raw response — §4 wants a record of what went to air. */
  recordPath?: string | undefined;
  url?: string;
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocket;
  maxBackoffMs?: number;
}

export interface RealtimeResponse {
  tokens?: SonioxToken[];
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

export interface SonioxRealtimeEvents {
  tokens: [SonioxToken[]];
  open: [];
  /** Outage duration, so the pipeline can mark a hole in the transcript. */
  gap: [number];
  finished: [];
  error: [Error];
}

export class SonioxRealtimeClient extends EventEmitter<SonioxRealtimeEvents> {
  private readonly config: RealtimeConfig;
  private socket: WebSocket | undefined;
  private recorder: WriteStream | undefined;
  private closedByUs = false;
  private attempt = 0;
  private disconnectedAt: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: RealtimeConfig) {
    super();
    this.config = config;
    if (config.recordPath) {
      this.recorder = createWriteStream(config.recordPath, { flags: 'a' });
    }
  }

  /** The exact first frame. `include_nonfinal` is false unless the raw
   *  passthrough overlay asked for it (INVARIANT 4). */
  buildConfigMessage(): Record<string, unknown> {
    return {
      api_key: this.config.apiKey,
      model: this.config.model,
      audio_format: 'pcm_s16le',
      sample_rate: this.config.sampleRate,
      num_channels: 1,
      language_hints: this.config.languageHints,
      ...(this.config.languageHintsStrict ? { language_hints_strict: true } : {}),
      enable_language_identification: true,
      enable_speaker_diarization: this.config.enableSpeakerDiarization ?? true,
      // Real-time HAS endpoint detection, unlike the async API. This is what
      // tells the line builder a clause is complete.
      enable_endpoint_detection: true,
      // Left unset, Soniox waits as long as it likes to call a clause finished,
      // and nothing can be translated until it does. These two decide the half
      // of caption latency that is not ours.
      ...(this.config.endpointSensitivity !== undefined
        ? { endpoint_sensitivity: this.config.endpointSensitivity }
        : {}),
      ...(this.config.maxEndpointDelayMs !== undefined
        ? { max_endpoint_delay_ms: this.config.maxEndpointDelayMs }
        : {}),
      include_nonfinal: this.config.includeNonFinal ?? INCLUDE_NON_FINAL,
      translation: {
        type: 'one_way',
        target_language: this.config.targetLanguage,
      },
      // Absent until now, so every term in config.json was honoured by the
      // weekly export and silently ignored on air.
      ...(this.config.context ? { context: this.config.context } : {}),
    };
  }

  connect(): void {
    this.closedByUs = false;
    const url = this.config.url ?? REALTIME_URL;
    const socket = this.config.createSocket
      ? this.config.createSocket(url)
      : new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      if (this.disconnectedAt !== undefined) {
        this.emit('gap', Date.now() - this.disconnectedAt);
        this.disconnectedAt = undefined;
      }
      this.attempt = 0;
      socket.send(JSON.stringify(this.buildConfigMessage()));
      this.emit('open');
    });

    socket.on('message', (data: WebSocket.RawData) => {
      const text = typeof data === 'string' ? data : data.toString();
      this.record(text);
      let response: RealtimeResponse;
      try {
        response = JSON.parse(text) as RealtimeResponse;
      } catch {
        return;
      }
      if (response.error_code) {
        this.emit(
          'error',
          new Error(`soniox ${response.error_code}: ${response.error_message ?? 'unknown'}`),
        );
        return;
      }
      if (response.tokens?.length) this.emit('tokens', response.tokens);
      if (response.finished) this.emit('finished');
    });

    socket.on('error', (err: Error) => this.emit('error', err));

    socket.on('close', () => {
      if (this.closedByUs) return;
      if (this.disconnectedAt === undefined) this.disconnectedAt = Date.now();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const max = this.config.maxBackoffMs ?? 15_000;
    const delay = Math.min(500 * 2 ** this.attempt++, max);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * §8: never buffer stale audio during a reconnect — drop it. Sending it late
   * would put captions permanently behind the speaker.
   */
  sendAudio(chunk: Buffer): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(chunk);
    return true;
  }

  private record(line: string): void {
    if (!this.recorder) return;
    // §4: `{ at, res }` per line.
    this.recorder.write(`${JSON.stringify({ at: Date.now(), res: line })}\n`);
  }

  /** Append an operator action or service metadata to the same JSONL. */
  recordEvent(event: Record<string, unknown>): void {
    if (!this.recorder) return;
    this.recorder.write(`${JSON.stringify({ at: Date.now(), event })}\n`);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      // Empty frame signals end of stream; the server replies `finished`.
      this.socket.send('');
      this.socket.close();
    }
    await new Promise<void>((resolvePromise) => {
      if (!this.recorder) return resolvePromise();
      this.recorder.end(() => resolvePromise());
    });
  }
}
