import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { resolveApiKey } from '../config.js';
import { AudioCapture, type CaptureFormat } from '../live/capture.js';
import { SonioxRealtimeClient } from '../live/soniox/client.js';
import { LineBuilder } from '../live/pipeline/lineBuilder.js';
import { CaptionQueue } from '../live/pipeline/queue.js';
import { BrowserAdapter } from '../live/adapters/browser.js';
import { StubAdapter } from '../live/adapters/stub.js';
import { VmixAdapter } from '../live/adapters/vmix.js';
import { YoutubeLiveAdapter } from '../live/adapters/youtubeLive.js';
import { listAudioDevices } from '../live/devices.js';
import { BridgeServer, type OperatorCommand } from '../live/server.js';
import { outputConfigs, type OutputName } from '../live/outputs.js';
import type { CaptionLine } from '../live/types.js';
import { info, warn } from '../util/log.js';

export interface LiveArgs {
  device: string;
  format?: CaptureFormat | undefined;
  /** YouTube live caption ingestion URL, from the stream's CC settings. */
  youtubeCaptionsUrl?: string | undefined;
  /** Delay between this machine's encoder and YouTube receiving the video. */
  streamOffsetMs?: number | undefined;
  /** Drive a vMix GT title as well as the browser overlays. */
  captionInput?: string | undefined;
  /** Which outputs to serve. Defaults to venue + stream. */
  outputs?: OutputName[];
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
 */
export async function runLive(args: LiveArgs, config: AppConfig): Promise<void> {
  const apiKey = resolveApiKey(config);
  const token = args.token ?? randomBytes(8).toString('hex');
  const names: OutputName[] = args.outputs ?? ['venue', 'stream'];
  const configs = outputConfigs(config);

  // The session epoch anchors INVARIANT 9. Everything is scheduled relative to
  // this instant, never to when a token happened to arrive.
  const sessionEpoch = Date.now();
  const queue = new CaptionQueue({ sessionEpoch });

  const overlays = new Map<string, BrowserAdapter>();
  for (const name of names) {
    const adapter = new BrowserAdapter(name);
    overlays.set(name, adapter);
    queue.addOutput(configs[name], adapter);
  }

  const stub = new StubAdapter('stub', { log: args.verbose ?? false });
  queue.addOutput(configs.stub, stub);

  // Closed captions on the public stream. Attached to the stream output's own
  // config, so it inherits the reviewed delay and every drop and correction
  // the reviewer makes, with no scheduling of its own.
  if (args.youtubeCaptionsUrl) {
    const youtube = new YoutubeLiveAdapter({
      ingestionUrl: args.youtubeCaptionsUrl,
      sessionEpoch,
      streamOffsetMs: args.streamOffsetMs ?? 0,
      onError: (err) => warn(`youtube captions: ${err.message}`),
    });
    queue.addOutput({ ...configs.stream, name: 'youtube' }, youtube);
    info('posting closed captions to YouTube');
  }

  // The GT title route, for a night when a Browser input misbehaves.
  if (args.captionInput) {
    const gt = new VmixAdapter({ inputGuid: args.captionInput });
    queue.addOutput({ ...configs.venue, name: 'vmix-title' }, gt);
    info(`driving vMix GT title ${args.captionInput}`);
  }

  const client = new SonioxRealtimeClient({
    apiKey,
    model: 'stt-rt-v5',
    sampleRate: 16000,
    languageHints: config.soniox.sourceLanguages,
    targetLanguage: config.soniox.targetLanguage,
    recordPath: args.recordPath ? resolve(args.recordPath) : undefined,
  });

  // Capture is created before the server so the control page can start and
  // stop it, but is not started until the session is running.
  let capturing = false;
  let currentDevice = args.device;
  let lastLevel = 0;

  const server = new BridgeServer({
    host: config.server.host,
    port: config.server.port,
    outputs: overlays,
    token,
    listDevices: () => listAudioDevices(args.format),
    sessionStatus: () => ({ running: capturing, device: currentDevice, level: lastLevel }),
    onSession: (action, device) => {
      if (action === 'stop') {
        capture.stop();
        capturing = false;
        return;
      }
      if (capturing) capture.stop();
      if (device) currentDevice = device;
      capture.setDevice(currentDevice);
      capture.start();
      capturing = true;
    },
    onCommand: (command: OperatorCommand) => {
      client.recordEvent({ operator: command });
      switch (command.type) {
        case 'drop':
          // Only the reviewed path is subject to review; the venue screen has
          // already shown it by now.
          if (command.lineId) queue.drop(command.lineId, 'reviewer', 'stream');
          break;
        case 'edit':
          // Same scope as drop, and the same advisory contract: if the line has
          // already gone out the queue rejects it rather than chasing it.
          if (command.lineId && command.text !== undefined) {
            queue.editLine(command.lineId, command.text, 'reviewer', 'stream');
            edited.add(command.lineId);
            publishView();
          }
          break;
        case 'hold':
          queue.hold();
          break;
        case 'resume':
          queue.resume();
          break;
        case 'captions-off':
          void queue.clearAll();
          queue.hold();
          break;
        case 'captions-on':
          queue.resume();
          break;
      }
    },
  });

  queue.on((event) => {
    server.notify(event);
    if (event.type === 'skipped') {
      warn(`skipped on ${event.output}: ${event.lateByMs}ms late`);
    }
  });

  const builder = new LineBuilder({
    pauseMs: config.ingest.pauseMs,
    maxChars: config.ingest.maxChars,
    maxSegmentMs: config.ingest.maxSegmentMs,
    minDisplayMs: config.live.minDisplayMs,
  });

  /** Lines the reviewer has not yet run out of time on. */
  const awaitingReview: CaptionLine[] = [];
  const reviewWindowMs = config.live.delayReviewMs;
  /** Line ids a correction has already been queued against. */
  const edited = new Set<string>();

  function publishView(): void {
    const now = Date.now();
    // Drop anything already past its air time out of the reviewer's view.
    while (awaitingReview.length > 0) {
      const head = awaitingReview[0]!;
      if (sessionEpoch + head.audioStartMs + configs.stream.delayMs > now) break;
      awaitingReview.shift();
    }

    server.publish({
      // Every line still in the window, not just the head: at three minutes
      // there are tens in flight and the reviewer has to see which is closest
      // to expiring.
      pending: awaitingReview.map((line) => ({
        ...line,
        deadlineAt: sessionEpoch + line.audioStartMs + configs.stream.delayMs,
        // The bar drains from the moment the line reached the reviewer feed
        // (assembly delay), not from when it was spoken.
        visibleFrom: sessionEpoch + line.audioStartMs + config.live.delayAssemblyMs,
        edited: edited.has(line.id),
      })),
      windowMs: reviewWindowMs,
    });
  }

  client.on('tokens', (tokens) => {
    for (const line of builder.push(tokens)) {
      queue.add(line);
      awaitingReview.push(line);
    }
    publishView();
  });

  client.on('gap', (durationMs) => {
    queue.gap(durationMs);
    warn(`audio gap: ${Math.round(durationMs / 1000)}s`);
  });

  client.on('error', (err) => warn(`soniox: ${err.message}`));
  client.on('open', () => info('connected to Soniox'));

  const capture = new AudioCapture({
    device: args.device,
    format: args.format,
    sampleRate: 16000,
  });

  let silentChunks = 0;
  capture.on('audio', (chunk) => client.sendAudio(chunk));
  capture.on('level', (level) => {
    lastLevel = level;
    // A silent cable and a silent speaker look identical without this.
    if (level < 0.0005) {
      silentChunks++;
      if (silentChunks === 250) warn('30s of silence — check the audio cable is routed');
    } else {
      silentChunks = 0;
    }
  });
  capture.on('error', (err) => warn(`capture: ${err.message}`));

  await server.start();
  client.connect();
  capture.start();
  capturing = true;
  queue.start(100);

  const viewTimer = setInterval(publishView, 250);

  client.recordEvent({
    session: { sessionEpoch, device: args.device, outputs: names },
  });

  info('');
  info('Running. Press Ctrl+C to stop.');

  await new Promise<void>((resolvePromise) => {
    const shutdown = async () => {
      info('stopping…');
      clearInterval(viewTimer);
      capture.stop();
      for (const line of builder.flush()) queue.add(line);
      await client.close();
      await queue.close();
      await server.stop();
      resolvePromise();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}
