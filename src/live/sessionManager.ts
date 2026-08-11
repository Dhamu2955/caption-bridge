import type { AppConfig } from '../config.js';
import { resolveApiKey } from '../config.js';
import type { CaptureFormat } from './capture.js';
import { LiveSession, type SessionSink, type SessionStatus } from './session.js';
import type { OutputName } from './outputs.js';
import type { OverlayRegistry } from './overlays.js';
import type { OperatorCommand } from './server.js';
import type { CheckId } from './preflight.js';
import { info } from '../util/log.js';

/**
 * Owns the at-most-one caption session, so the server can stay up between them.
 *
 * At most one on purpose: a second Soniox connection would double the bill
 * without feeding a single extra screen. INVARIANT 7 is that outputs are cheap
 * and sessions are not.
 */

/** A start that cannot happen yet, named so the UI can point at the right card. */
export class NotConfiguredError extends Error {
  readonly check: CheckId;
  constructor(check: CheckId, message: string) {
    super(message);
    this.check = check;
  }
}

export interface StartArgs {
  device: string;
  /** 1-based input channel to take. Undefined mixes them all. */
  channel?: number | undefined;
  outputs?: OutputName[];
  format?: CaptureFormat | undefined;
  youtubeCaptionsUrl?: string | undefined;
  streamOffsetMs?: number | undefined;
  captionInput?: string | undefined;
  recordPath?: string | undefined;
  verbose?: boolean;
}

export interface LiveSessionManagerOptions {
  /** Read through the settings store, so an edit is picked up next start. */
  getConfig: () => AppConfig;
  overlays: OverlayRegistry;
  /** Applied to every start unless the caller overrides them. */
  defaults?: Partial<StartArgs>;
  /**
   * Read at start time rather than held, so a URL pasted into the settings
   * page reaches the next session with nothing restarted.
   */
  getYoutubeCaptionsUrl?: () => string | undefined;
}

export interface ManagerStatus extends Partial<SessionStatus> {
  state: SessionStatus['state'];
  running: boolean;
}

export class LiveSessionManager {
  private readonly options: LiveSessionManagerOptions;
  private sink: SessionSink | undefined;
  private session: LiveSession | undefined;
  /** Remembered so the control page can offer it again after a stop. */
  private lastDevice: string | undefined;
  private lastChannel: number | undefined;
  private lastFormat: CaptureFormat | undefined;

  constructor(options: LiveSessionManagerOptions) {
    this.options = options;
  }

  /**
   * The server is the sink, and the server needs this manager for its
   * callbacks. Construct the manager, then the server, then join them here.
   */
  attachSink(sink: SessionSink): void {
    this.sink = sink;
  }

  get current(): LiveSession | undefined {
    return this.session;
  }

  get status(): ManagerStatus {
    if (!this.session) {
      return {
        state: 'idle',
        running: false,
        ...(this.lastDevice ? { device: this.lastDevice } : {}),
        ...(this.lastChannel ? { channel: this.lastChannel } : {}),
      };
    }
    return { ...this.session.status, running: this.session.status.running };
  }

  async start(args: StartArgs): Promise<LiveSession> {
    if (!this.sink) throw new Error('no sink attached');

    const config = this.options.getConfig();
    const merged = { ...this.options.defaults, ...args };

    let apiKey: string;
    try {
      apiKey = resolveApiKey(config);
    } catch (err) {
      throw new NotConfiguredError('apiKey', (err as Error).message);
    }
    if (!merged.device || merged.device.trim() === '') {
      throw new NotConfiguredError('devices', 'choose the sound input carrying the speaker first');
    }

    // Replacing a running session rather than refusing: the operator pressing
    // start again means "use this device now", and making them stop first would
    // be a step with no purpose.
    if (this.session) await this.stop();

    const session = new LiveSession({
      config,
      apiKey,
      device: merged.device,
      channel: merged.channel,
      format: merged.format,
      outputs: merged.outputs ?? ['venue', 'stream'],
      overlays: this.options.overlays,
      sink: this.sink,
      youtubeCaptionsUrl: merged.youtubeCaptionsUrl ?? this.options.getYoutubeCaptionsUrl?.(),
      streamOffsetMs: merged.streamOffsetMs ?? config.live.streamOffsetMs,
      captionInput: merged.captionInput,
      recordPath: merged.recordPath,
      verbose: merged.verbose ?? false,
    });

    session.start();
    this.session = session;
    this.lastDevice = merged.device;
    this.lastChannel = merged.channel;
    this.lastFormat = merged.format;
    info(
      merged.format === 'file'
        ? `captions started, playing in ${merged.device}`
        : `captions started on ${merged.device}`,
    );
    return session;
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    await session.stop();
    await this.options.overlays.clearAll();
    info('captions ended');
  }

  /**
   * What the control page's Start and Stop buttons mean.
   *
   * Stop is capture-only, exactly as it has always been: the queue keeps
   * draining so everything already spoken still reaches air. Ending a session
   * outright — which discards that backlog — is the separate `end` action.
   */
  async handle(
    action: 'start' | 'stop' | 'end',
    device?: string,
    options: { format?: CaptureFormat | undefined; channel?: number | undefined } = {},
  ): Promise<void> {
    if (action === 'end') {
      await this.stop();
      return;
    }

    if (action === 'stop') {
      this.session?.pauseCapture();
      return;
    }

    // Switching between a microphone and a recording changes how ffmpeg is
    // invoked, so it needs a new session rather than a resume.
    const formatChanged = options.format !== undefined && options.format !== this.lastFormat;
    // Same reasoning as the format: which channel is taken is baked into the
    // ffmpeg command line, so changing it has to reach a new capture.
    const channelChanged = options.channel !== this.lastChannel;

    if (this.session && !formatChanged && !channelChanged) {
      this.session.resumeCapture(device, options.channel);
      if (device) this.lastDevice = device;
      return;
    }

    await this.start({
      device: device ?? this.lastDevice ?? '',
      channel: options.channel,
      ...(options.format ? { format: options.format } : {}),
    });
  }

  /** Advisory, and harmless when nothing is running. */
  command(command: OperatorCommand): void {
    this.session?.command(command);
  }
}
