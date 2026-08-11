import { resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { AudioCapture, type CaptureFormat } from './capture.js';
import { SonioxRealtimeClient } from './soniox/client.js';
import { buildContext } from '../soniox/context.js';
import { LineBuilder } from './pipeline/lineBuilder.js';
import { LiveSrtWriter } from './liveSrt.js';
import { StubAdapter } from './adapters/stub.js';
import { VmixAdapter } from './adapters/vmix.js';
import { YoutubeLiveAdapter, checkIngestionUrl } from './adapters/youtubeLive.js';
import type { BrowserAdapter } from './adapters/browser.js';
import { INCLUDE_NON_FINAL, type CaptionLine, type QueueEvent } from './types.js';
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

/** Where queue activity goes, for the counters on the Captions tab. */
export interface SessionSink {
  notify(event: QueueEvent): void;
}

export interface LiveSessionOptions {
  config: AppConfig;
  apiKey: string;
  device: string;
  format?: CaptureFormat | undefined;
  /** 1-based input channel to take. Undefined mixes them all — see capture.ts. */
  channel?: number | undefined;
  /**
   * The caption screen. Long-lived and owned by the server, never replaced —
   * see adapters/browser.ts for why a session must not close it.
   */
  overlay: BrowserAdapter;
  sink: SessionSink;
  youtubeCaptionsUrl?: string | undefined;
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
  private readonly builder: LineBuilder;
  private readonly client: SonioxRealtimeClient;
  private readonly capture: AudioCapture;
  /** Drives checkFeed — the "is the cable still live" alarm. */
  private viewTimer: ReturnType<typeof setInterval> | undefined;
  private lastSpeechAt: number | undefined;
  private lastSilenceWarnAt = 0;
  private lastLevel = 0;
  private lastCaptureError: string | null = null;
  private youtube: YoutubeLiveAdapter | undefined;
  private vmix: VmixAdapter | undefined;
  private readonly srt: LiveSrtWriter | undefined;
  private capturing = false;
  private startedAt: number | undefined;
  private state: SessionState = 'idle';

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.epoch = Date.now();

    if (options.youtubeCaptionsUrl) {
      const check = checkIngestionUrl(options.youtubeCaptionsUrl);
      if (!check.ok) throw new Error(`youtube captions: ${check.error}`);
      for (const message of check.warnings) warn(`youtube captions: ${message}`);

      this.youtube = new YoutubeLiveAdapter({
        ingestionUrl: options.youtubeCaptionsUrl,
        onError: (err) => warn(`youtube captions: ${err.message}`),
      });
      info('posting closed captions to YouTube');
    }

    if (options.captionInput) {
      this.vmix = new VmixAdapter({ inputGuid: options.captionInput });
      info(`driving vMix GT title ${options.captionInput}`);
    }

    if (options.config.live.liveSrt) {
      this.srt = new LiveSrtWriter(
        LiveSrtWriter.pathFor(options.config.paths.recordings, new Date(this.epoch)),
      );
      info(`writing subtitles to ${this.srt.path}`);
    }

    this.builder = new LineBuilder({
      pauseMs: options.config.ingest.pauseMs,
      maxChars: options.config.ingest.maxChars,
      maxSegmentMs: options.config.ingest.maxSegmentMs,
      minDisplayMs: options.config.ingest.minDisplayMs,
      maxBufferMs: options.config.live.maxBufferMs,
    });

    const clientOptions = {
      apiKey: options.apiKey,
      model: 'stt-rt-v5',
      sampleRate: 16000,
      languageHints: options.config.soniox.sourceLanguages,
      languageHintsStrict: options.config.soniox.languageHintsStrict,
      targetLanguage: options.config.soniox.targetLanguage,
      context: buildContext(options.config),
      endpointSensitivity: options.config.live.endpointSensitivity,
      maxEndpointDelayMs: options.config.live.maxEndpointDelayMs,
      // INVARIANT 4 rule 1. Nothing here renders provisional text, so there is
      // nothing to ask for — and asking would put revisable tokens one bug away
      // from a screen.
      includeNonFinal: INCLUDE_NON_FINAL,
      recordPath: options.recordPath ? resolve(options.recordPath) : undefined,
    } as const;
    this.client = options.createClient
      ? options.createClient(clientOptions)
      : new SonioxRealtimeClient(clientOptions);

    this.client.on('tokens', (tokens) => {
      for (const line of this.builder.push(tokens)) this.deliver(line);
    });
    this.client.on('gap', (durationMs) => {
      options.sink.notify({ type: 'gap', durationMs });
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
   * One finished line, to every screen that wants it.
   *
   * This is the whole of what used to be a 330-line scheduler. There is no
   * delay left to schedule against: a line exists only once Soniox has
   * finalised and translated it, and that moment is the moment it belongs on
   * screen.
   *
   * The order is deliberate. The overlay is the job — a projector in a hall
   * full of people — so it goes first and synchronously. Everything after it is
   * either a network call that must not block the screen or a by-product that
   * must not be able to take the broadcast down, and each swallows its own
   * failures by contract.
   */
  private deliver(line: CaptionLine): void {
    this.options.overlay.show(line);
    void this.youtube?.show(line);
    void this.vmix?.show(line);
    this.srt?.add(line);
    this.options.sink.notify({ type: 'line', line });
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
    this.viewTimer = setInterval(() => this.checkFeed(), 250);
    this.client.recordEvent({
      session: {
        sessionEpoch: this.sessionEpoch,
        device: this.capture.device,
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

  /** Idempotent, and must never throw — it runs on the shutdown path. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';

    if (this.viewTimer) clearInterval(this.viewTimer);
    this.viewTimer = undefined;
    this.capture.stop();
    this.capturing = false;

    // Whatever is still buffered goes out before the socket closes.
    for (const line of this.builder.flush()) this.deliver(line);
    await this.client.close();

    // Blanked rather than left frozen on the last line of a finished service,
    // and so a page connecting between sessions is not replayed the previous
    // one's words.
    this.options.overlay.clear();
    this.vmix?.clear();
  }
}
