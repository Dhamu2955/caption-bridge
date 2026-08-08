import { resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { AudioCapture, type CaptureFormat } from './capture.js';
import { SonioxRealtimeClient } from './soniox/client.js';
import { LineBuilder } from './pipeline/lineBuilder.js';
import { CaptionQueue } from './pipeline/queue.js';
import type { BrowserAdapter } from './adapters/browser.js';
import { StubAdapter } from './adapters/stub.js';
import { VmixAdapter } from './adapters/vmix.js';
import { YoutubeLiveAdapter, checkIngestionUrl } from './adapters/youtubeLive.js';
import { outputConfigs, type OutputName } from './outputs.js';
import type { OverlayRegistry } from './overlays.js';
import type { OperatorCommand, OperatorView } from './server.js';
import type { CaptionLine, QueueEvent } from './types.js';
import { info, warn } from '../util/log.js';

/**
 * One run of captions: capture → Soniox → lines → queue → outputs.
 *
 * Split out of `runLive` so the HTTP server can outlive it. The server is the
 * thing an operator opens in a browser; a session is the thing they start and
 * stop from that browser, possibly several times before a service settles.
 *
 * What lives here is what genuinely belongs to one run — above all the session
 * epoch, which every release instant is measured from (INVARIANT 9). What does
 * NOT live here is the overlay adapters: see `OverlayRegistry` for why.
 */

/** Where the reviewer's view goes. `BridgeServer` satisfies this already. */
export interface SessionSink {
  publish(view: OperatorView): void;
  notify(event: QueueEvent): void;
}

export interface LiveSessionOptions {
  config: AppConfig;
  apiKey: string;
  device: string;
  format?: CaptureFormat | undefined;
  outputs: OutputName[];
  /** Long-lived, owned by the server. Read, never replaced. */
  overlays: OverlayRegistry;
  sink: SessionSink;
  youtubeCaptionsUrl?: string | undefined;
  streamOffsetMs?: number | undefined;
  captionInput?: string | undefined;
  recordPath?: string | undefined;
  verbose?: boolean;
  /** Injected in tests so no ffmpeg or websocket is needed. */
  createCapture?: (options: {
    device: string;
    format?: CaptureFormat | undefined;
    sampleRate: number;
  }) => AudioCapture;
  createClient?: (options: ConstructorParameters<typeof SonioxRealtimeClient>[0]) =>
    SonioxRealtimeClient;
}

export type SessionState = 'idle' | 'running' | 'paused' | 'stopped';

export interface SessionStatus {
  state: SessionState;
  /** True only while audio is actually being captured. */
  running: boolean;
  device: string;
  level: number;
  outputs: string[];
  sessionEpoch: number;
  startedAt: number | undefined;
}

export class LiveSession {
  /** Wall clock for audio position 0. Fixed for the life of the session. */
  readonly sessionEpoch: number;

  private readonly options: LiveSessionOptions;
  private readonly queue: CaptionQueue;
  private readonly builder: LineBuilder;
  private readonly client: SonioxRealtimeClient;
  private readonly capture: AudioCapture;
  /** Delays snapshotted at construction — a settings edit mid-service must not
   *  re-time lines that were already scheduled against the old ones. */
  private readonly configs: ReturnType<typeof outputConfigs>;
  /** Outputs a reviewer decision applies to. Includes the YouTube caption
   *  output when there is one: it carries the stream's schedule under its own
   *  name, so leaving it out silently let dropped lines go to air. */
  private readonly reviewedOutputs: string[] = ['stream'];

  private readonly awaitingReview: CaptionLine[] = [];
  private readonly edited = new Set<string>();
  private viewTimer: ReturnType<typeof setInterval> | undefined;
  private silentChunks = 0;
  private lastLevel = 0;
  private capturing = false;
  private startedAt: number | undefined;
  private state: SessionState = 'idle';

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.sessionEpoch = Date.now();
    this.configs = outputConfigs(options.config);
    this.queue = new CaptionQueue({ sessionEpoch: this.sessionEpoch });

    for (const name of options.outputs) {
      const adapter = options.overlays.get(name);
      if (!adapter) {
        warn(`no overlay registered for output "${name}"`);
        continue;
      }
      // Binds to the adapter the server already owns, so overlay pages opened
      // before this session keep working.
      this.queue.addOutput(this.configs[name], adapter);
    }

    const stub = new StubAdapter('stub', { log: options.verbose ?? false });
    this.queue.addOutput(this.configs.stub, stub);

    if (options.youtubeCaptionsUrl) {
      const check = checkIngestionUrl(options.youtubeCaptionsUrl);
      if (!check.ok) throw new Error(`youtube captions: ${check.error}`);
      for (const message of check.warnings) warn(`youtube captions: ${message}`);

      const youtube = new YoutubeLiveAdapter({
        ingestionUrl: options.youtubeCaptionsUrl,
        sessionEpoch: this.sessionEpoch,
        streamOffsetMs: options.streamOffsetMs ?? 0,
        onError: (err) => warn(`youtube captions: ${err.message}`),
      });
      this.queue.addOutput({ ...this.configs.stream, name: 'youtube' }, youtube);
      this.reviewedOutputs.push('youtube');
      info('posting closed captions to YouTube');
    }

    if (options.captionInput) {
      const gt = new VmixAdapter({ inputGuid: options.captionInput });
      this.queue.addOutput({ ...this.configs.venue, name: 'vmix-title' }, gt);
      info(`driving vMix GT title ${options.captionInput}`);
    }

    this.queue.on((event) => {
      options.sink.notify(event);
      if (event.type === 'skipped') {
        warn(`skipped on ${event.output}: ${event.lateByMs}ms late`);
      }
    });

    this.builder = new LineBuilder({
      pauseMs: options.config.ingest.pauseMs,
      maxChars: options.config.ingest.maxChars,
      maxSegmentMs: options.config.ingest.maxSegmentMs,
      minDisplayMs: options.config.live.minDisplayMs,
      maxBufferMs: options.config.live.maxBufferMs,
    });

    const clientOptions = {
      apiKey: options.apiKey,
      model: 'stt-rt-v5',
      sampleRate: 16000,
      languageHints: options.config.soniox.sourceLanguages,
      targetLanguage: options.config.soniox.targetLanguage,
      recordPath: options.recordPath ? resolve(options.recordPath) : undefined,
    } as const;
    this.client = options.createClient
      ? options.createClient(clientOptions)
      : new SonioxRealtimeClient(clientOptions);

    this.client.on('tokens', (tokens) => {
      for (const line of this.builder.push(tokens)) {
        this.queue.add(line);
        this.awaitingReview.push(line);
      }
      this.publishView();
    });
    this.client.on('gap', (durationMs) => {
      this.queue.gap(durationMs);
      warn(`audio gap: ${Math.round(durationMs / 1000)}s`);
    });
    this.client.on('error', (err) => warn(`soniox: ${err.message}`));
    this.client.on('open', () => info('connected to Soniox'));

    const captureOptions = {
      device: options.device,
      format: options.format,
      sampleRate: 16000,
    };
    this.capture = options.createCapture
      ? options.createCapture(captureOptions)
      : new AudioCapture(captureOptions);

    this.capture.on('audio', (chunk) => this.client.sendAudio(chunk));
    this.capture.on('level', (level) => {
      this.lastLevel = level;
      // A silent cable and a silent speaker look identical without this.
      if (level < 0.0005) {
        this.silentChunks++;
        if (this.silentChunks === 250) warn('30s of silence — check the audio cable is routed');
      } else {
        this.silentChunks = 0;
      }
    });
    this.capture.on('error', (err) => warn(`capture: ${err.message}`));
  }

  /**
   * The recording being played in, if this session is fed from a file.
   *
   * The media route serves exactly this and takes no path of its own, so there
   * is no parameter for anyone to point at /etc/passwd.
   */
  get mediaPath(): string | undefined {
    return this.options.format === 'file' ? resolve(this.options.device) : undefined;
  }

  get status(): SessionStatus {
    return {
      state: this.state,
      running: this.capturing,
      device: this.capture.device,
      level: this.lastLevel,
      outputs: this.options.outputs,
      sessionEpoch: this.sessionEpoch,
      startedAt: this.startedAt,
    };
  }

  start(): void {
    this.client.connect();
    this.capture.start();
    this.capturing = true;
    this.state = 'running';
    this.startedAt = Date.now();
    this.queue.start(100);
    this.viewTimer = setInterval(() => this.publishView(), 250);
    this.client.recordEvent({
      session: {
        sessionEpoch: this.sessionEpoch,
        device: this.capture.device,
        outputs: this.options.outputs,
      },
    });
  }

  /**
   * Stop capturing, and nothing else.
   *
   * The Soniox socket stays open and the queue keeps draining, so everything
   * already spoken still reaches air on schedule. That is the whole point:
   * pressing Stop three minutes before the end of a sermon must not swallow the
   * three minutes still in flight.
   */
  pauseCapture(): void {
    if (!this.capturing) return;
    this.capture.stop();
    this.capturing = false;
    this.state = 'paused';
  }

  resumeCapture(device?: string): void {
    if (this.capturing) this.capture.stop();
    if (device) this.capture.setDevice(device);
    this.capture.start();
    this.capturing = true;
    this.state = 'running';
  }

  setDevice(device: string): void {
    this.capture.setDevice(device);
  }

  /** Advisory: the queue decides whether a decision still applies. */
  command(command: OperatorCommand): void {
    this.client.recordEvent({ operator: command });
    switch (command.type) {
      case 'drop':
        // Only the reviewed path is subject to review; the venue screen has
        // already shown it by now.
        if (command.lineId) this.queue.drop(command.lineId, 'reviewer', this.reviewedOutputs);
        break;
      case 'edit':
        // Same scope as drop, and the same advisory contract: if the line has
        // already gone out the queue rejects it rather than chasing it.
        if (command.lineId && command.text !== undefined) {
          this.queue.editLine(command.lineId, command.text, 'reviewer', this.reviewedOutputs);
          this.edited.add(command.lineId);
          this.publishView();
        }
        break;
      case 'hold':
        this.queue.hold();
        break;
      case 'resume':
        this.queue.resume();
        break;
      case 'captions-off':
        void this.queue.clearAll();
        this.queue.hold();
        break;
      case 'captions-on':
        this.queue.resume();
        break;
    }
  }

  /** Idempotent, and must never throw — it runs on the shutdown path. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';

    if (this.viewTimer) clearInterval(this.viewTimer);
    this.viewTimer = undefined;
    this.capture.stop();
    this.capturing = false;

    for (const line of this.builder.flush()) this.queue.add(line);
    await this.client.close();

    // Before close, so each overlay is blanked rather than left frozen on the
    // last line of a finished service — and so a page connecting between
    // sessions is not replayed something from the previous one.
    await this.queue.clearAll();
    await this.queue.close();

    this.awaitingReview.length = 0;
    this.edited.clear();
    this.options.sink.publish({ pending: [], windowMs: this.options.config.live.delayReviewMs });
  }

  private publishView(): void {
    const now = Date.now();
    // Drop anything already past its air time out of the reviewer's view.
    while (this.awaitingReview.length > 0) {
      const head = this.awaitingReview[0]!;
      if (this.sessionEpoch + head.audioStartMs + this.configs.stream.delayMs > now) break;
      this.awaitingReview.shift();
    }

    this.options.sink.publish({
      // Every line still in the window, not just the head: at three minutes
      // there are tens in flight and the reviewer has to see which is closest
      // to expiring.
      pending: this.awaitingReview.map((line) => ({
        ...line,
        deadlineAt: this.sessionEpoch + line.audioStartMs + this.configs.stream.delayMs,
        // The bar drains from the moment the line reached the reviewer feed
        // (assembly delay), not from when it was spoken.
        visibleFrom: this.sessionEpoch + line.audioStartMs + this.options.config.live.delayAssemblyMs,
        edited: this.edited.has(line.id),
      })),
      windowMs: this.options.config.live.delayReviewMs,
      sessionEpoch: this.sessionEpoch,
      ...(this.options.format === 'file' ? { media: { url: '/api/media', kind: 'file' as const } } : {}),
    });
  }
}
