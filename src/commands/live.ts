import { randomBytes } from 'node:crypto';

import type { AppConfig } from '../config.js';
import { resolveApiKey } from '../config.js';
import type { CaptureFormat } from '../live/capture.js';
import { listAudioDevices } from '../live/devices.js';
import { BrowserAdapter } from '../live/adapters/browser.js';
import { BridgeServer } from '../live/server.js';
import { LiveSession } from '../live/session.js';
import { info } from '../util/log.js';

export interface LiveArgs {
  device: string;
  format?: CaptureFormat | undefined;
  /** YouTube live caption ingestion URL, from the stream's CC settings. */
  youtubeCaptionsUrl?: string | undefined;
  /** Delay between this machine's encoder and YouTube receiving the video. */
  streamOffsetMs?: number | undefined;
  /** Drive a vMix GT title as well as the browser overlays. */
  captionInput?: string | undefined;
  /** JSONL of every raw response plus operator actions. */
  recordPath?: string | undefined;
  /** Omit to generate one; §9 wants it rotated per event, never mid-service. */
  token?: string | undefined;
  /** Log every release to stderr as well. */
  verbose?: boolean;
}

/**
 * The live bridge. Capture → Soniox → lines → queue → outputs, with the
 * reviewer page attached as an advisory observer.
 *
 * Runs until interrupted. INVARIANT 10: nothing here waits on the reviewer.
 *
 * The machinery lives in `LiveSession`, which the `serve` command starts and
 * stops from a browser. This command is the one-shot form: start immediately,
 * run until Ctrl-C. It keeps the stricter behaviour of refusing to start
 * without a key or a named device, because a CLI invocation that silently sat
 * idle would be worse than an error.
 */
export async function runLive(args: LiveArgs, config: AppConfig): Promise<void> {
  const apiKey = resolveApiKey(config);
  const token = args.token ?? randomBytes(8).toString('hex');

  const overlay = new BrowserAdapter('captions');

  // The two reference each other: the server routes operator actions into the
  // session, and the session publishes the reviewer's view back through the
  // server. Annotated explicitly because that cycle defeats inference.
  const server: BridgeServer = new BridgeServer({
    host: config.server.host,
    port: config.server.port,
    overlay,
    token,
    listDevices: () => listAudioDevices(args.format),
    sessionStatus: () => {
      const status = session.status;
      return { running: status.running, device: status.device, level: status.level };
    },
    // Capture only — the queue keeps draining so everything already spoken
    // still reaches air. Wiring this to a full teardown would swallow the
    // three minutes still in flight.
    onSession: (action, device) => {
      if (action === 'stop') session.pauseCapture();
      else session.resumeCapture(device);
    },
  });

  const session: LiveSession = new LiveSession({
    config,
    apiKey,
    device: args.device,
    format: args.format,
    overlay,
    // The CLI path has no counters to feed; the queue's own logging is what
    // an operator watching a terminal has.
    sink: { notify: () => {} },
    youtubeCaptionsUrl: args.youtubeCaptionsUrl,
    streamOffsetMs: args.streamOffsetMs,
    captionInput: args.captionInput,
    recordPath: args.recordPath,
    verbose: args.verbose ?? false,
  });

  await server.start();
  session.start();

  info('');
  info('Running. Press Ctrl+C to stop.');

  await new Promise<void>((resolvePromise) => {
    const shutdown = async () => {
      info('stopping…');
      await session.stop();
      await server.stop();
      resolvePromise();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}
