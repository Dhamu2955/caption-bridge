import { resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { AudioCapture, type CaptureFormat } from './capture.js';
import { SonioxRealtimeClient } from './soniox/client.js';
import { buildContext } from '../soniox/context.js';
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
  /** 1-based input channel to take. Undefined mixes them all — see capture.ts. */
  channel?: number | undefined;
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
    channel?: number | undefined;
  }) => AudioCapture;
  createClient?: (options: ConstructorParameters<typeof SonioxRealtimeClient>[0]) =>
    SonioxRealtimeClient;
}

export type SessionState = 'idle' | 'running' | 'paused' | 'stopped';

/** Below this a chunk is treated as carrying no speech. */
const SPEECH_LEVEL = 0.0005;

export interface SessionStatus {
  state: SessionState;
  /** True only while audio is actually being captured. */
  running: boolean;
  device: string;
  /** The input channel being taken, when one was chosen. */
  channel?: number | undefined;
  /**
   * The last thing capture complained about, or null.
   *
   * It used to go to the server's terminal alone, which is the one screen
   * nobody is looking at: the operator may be driving this from a tablet in
   * another room, and a device that failed to open looked exactly like a
   * speaker who had not started yet.
   */
  captureError?: string | null;
  level: number;
  outputs: string[];
  sessionEpoch: number;
  startedAt: number | undefined;
  /**
   * How long the feed has carried no speech, or null when it is carrying some.
   *
   * The failure this catches is the quiet one: a cable pulled, a mixer bus
   * muted, a virtual cable pointed at the wrong application. Captions do not
   * error — they simply stop, and on a page full of green nothing says why.
   */
  silentForMs: number | null;
}

/** What the operator should do about `silentForMs`, if anything. */
export type FeedState = 'speech' | 'quiet' | 'silent';

/** A pause between sentences is normal; half a minute of nothing is not. */
export const QUIET_AFTER_MS = 12_000;
export const SILENT_AFTER_MS = 30_000;

export function feedState(silentForMs: number | null): FeedState {
  if (silentForMs === null || silentForMs < QUIET_AFTER_MS) return 'speech';
  return silentForMs < SILENT_AFTER_MS ? 'quiet' : 'silent';
}

export class LiveSession {
  /**
   * Wall clock for audio position 0.
   *
   * Set when the session is built and corrected once, if the first sample
   * turns out to have arrived materially later — see `markAudioStarted`. Fixed
   * from that point for the life of the session.
   */
  private epoch: number;

  get sessionEpoch(): number {
    return this.epoch;
  }

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
  private lastSpeechAt: number | undefined;
  private lastSilenceWarnAt = 0;
  private lastLevel = 0;
  private lastCaptureError: string | null = null;
  private audioStarted = false;
  private youtube: YoutubeLiveAdapter | undefined;
  private capturing = false;
  private startedAt: number | undefined;
  private state: SessionState = 'idle';

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.epoch = Date.now();
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

    // Only when asked for. Its delay is 0 and a caption cannot exist until the
    // speech it covers has finished, so every line arrives "late" for it and is
    // skipped — a warning per line, and 84 of them counted as Missed on a run
    // where nothing was actually missed. It is a development sink (§10), and
    // silent unless `verbose`, so off it was pure noise.
    if (options.verbose) {
      this.queue.addOutput(this.configs.stub, new StubAdapter('stub', { log: true }));
    }

    if (options.youtubeCaptionsUrl) {
      const check = checkIngestionUrl(options.youtubeCaptionsUrl);
      if (!check.ok) throw new Error(`youtube captions: ${check.error}`);
      for (const message of check.warnings) warn(`youtube captions: ${message}`);

      this.youtube = new YoutubeLiveAdapter({
        ingestionUrl: options.youtubeCaptionsUrl,
        sessionEpoch: this.sessionEpoch,
        streamOffsetMs: options.streamOffsetMs ?? 0,
        onError: (err) => warn(`youtube captions: ${err.message}`),
      });
      this.queue.addOutput({ ...this.configs.stream, name: 'youtube' }, this.youtube);
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
      context: buildContext(options.config),
      endpointSensitivity: options.config.live.endpointSensitivity,
      maxEndpointDelayMs: options.config.live.maxEndpointDelayMs,
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
      channel: options.channel,
    };
    this.capture = options.createCapture
      ? options.createCapture(captureOptions)
      : new AudioCapture(captureOptions);

    this.capture.on('audio', (chunk) => {
      this.markAudioStarted();
      this.client.sendAudio(chunk);
    });
    this.capture.on('level', (level) => {
      this.lastLevel = level;
      // A silent cable and a silent speaker look identical on a level meter
      // nobody is watching, so the duration is carried in the status instead
      // and the page decides how loudly to say it.
      if (level >= SPEECH_LEVEL) {
        this.lastSpeechAt = Date.now();
        this.lastSilenceWarnAt = 0;
      }
    });
    // Held as well as logged: the operator may be three rooms away with only
    // this page to go on, and "the device would not open" must reach them.
    this.capture.on('error', (err) => {
      this.lastCaptureError = err.message;
      warn(`capture: ${err.message}`);
    });
  }

  /**
   * How long the feed has carried no speech.
   *
   * Measured from the last chunk that had some, NOT by counting silent ones:
   * the failure most worth catching is the feed stopping altogether — a page
   * closed, a socket dropped, ffmpeg killed — and then no chunks arrive at all,
   * silent or otherwise. Counting silence sits at zero through exactly the
   * outage it exists to report. Found by killing a browser feed mid-session and
   * watching the alarm say nothing.
   *
   * Null while paused or stopped: nothing is listening, so "no speech" is the
   * expected state and flagging it would be noise.
   */
  private get silentForMs(): number | null {
    if (!this.capturing) return null;
    const since = this.lastSpeechAt ?? this.startedAt;
    return since === undefined ? null : Date.now() - since;
  }

  /** Repeated, not once: a cable out for ten minutes is still out. */
  private checkFeed(): void {
    const silentFor = this.silentForMs;
    if (silentFor === null || silentFor < SILENT_AFTER_MS) return;
    const now = Date.now();
    if (now - this.lastSilenceWarnAt < 60_000) return;
    this.lastSilenceWarnAt = now;
    warn(`${Math.round(silentFor / 1000)}s with no speech — check the audio routing`);
  }

  /**
   * The first sample is where the timeline really starts.
   *
   * A device or a file begins within milliseconds of `start()`, so the epoch
   * taken there is right. A browser does not: the page has to open a socket and
   * spin up an audio worklet, and if the operator is asked for microphone
   * permission it can be many seconds. Every one of those seconds is a caption
   * scheduled into the past, and `lateSkipMs` then drops the lot — captions
   * that never appear, with nothing on screen to say why.
   *
   * Measured on the first browser-fed session: 25 seconds of skew, 50 lines
   * skipped, 0 released.
   */
  private markAudioStarted(): void {
    if (this.audioStarted) return;
    this.audioStarted = true;

    const drift = Date.now() - this.epoch;
    // Under a second is the ordinary cost of spawning something, and re-basing
    // for it would only add jitter.
    if (drift < 1000) return;

    this.epoch += drift;
    this.queue.rebase(this.epoch);
    this.youtube?.rebase(this.epoch);
    info(`audio began ${(drift / 1000).toFixed(1)}s after start; timeline moved to match`);
  }

  /**
   * Audio pushed in from a browser, for `browser` capture.
   *
   * Ignored unless this session is actually capturing: a page that keeps
   * sending after Pause would otherwise inject speech into a queue whose
   * timeline has moved on, and the captions would land on the wrong moment.
   */
  pushAudio(chunk: Buffer): boolean {
    if (!this.capturing || this.options.format !== 'browser') return false;
    this.capture.push(chunk);
    return true;
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
      channel: this.capture.channel,
      captureError: this.lastCaptureError,
      level: this.lastLevel,
      outputs: this.options.outputs,
      sessionEpoch: this.sessionEpoch,
      startedAt: this.startedAt,
      silentForMs: this.silentForMs,
    };
  }

  start(): void {
    this.client.connect();
    this.lastCaptureError = null;
    this.capture.start();
    this.capturing = true;
    this.state = 'running';
    this.startedAt = Date.now();
    this.queue.start(100);
    this.viewTimer = setInterval(() => {
      this.publishView();
      this.checkFeed();
    }, 250);
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

  resumeCapture(device?: string, channel?: number | undefined): void {
    if (this.capturing) this.capture.stop();
    if (device) this.capture.setDevice(device, channel);
    this.lastCaptureError = null;
    this.capture.start();
    this.capturing = true;
    this.state = 'running';
  }

  setDevice(device: string, channel?: number | undefined): void {
    this.capture.setDevice(device, channel);
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
      // How far the picture must sit behind the capture point for a caption to
      // land on the words it describes. The page cannot guess this — it is the
      // delay the queue schedules against.
      assemblyMs: this.options.config.live.delayAssemblyMs,
      // The reviewer is the one person watching for ninety minutes, so the
      // quiet failure belongs on their screen too — not only on the setup page
      // nobody has open during a service.
      silentForMs: this.status.silentForMs,
      // Carries the session epoch so each run has its own URL. Without it the
      // browser reuses the 404 it cached while no session was running, and the
      // player stays dead through every later start.
      ...(this.options.format === 'file'
        ? { media: { url: `/api/media?session=${this.sessionEpoch}`, kind: 'file' as const } }
        : {}),
    });
  }
}
