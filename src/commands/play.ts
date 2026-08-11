import type { AppConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadSegments, resolveServiceRef } from '../db/services.js';
import { BrowserAdapter } from '../live/adapters/browser.js';
import { VmixAdapter, extractInputPosition } from '../live/adapters/vmix.js';
import { BridgeServer } from '../live/server.js';
import type { CaptionLine, OutputAdapter } from '../live/types.js';
import type { Segment } from '../segments/types.js';
import { toExportSegments } from './export.js';
import { info, warn } from '../util/log.js';

/**
 * Captions for a recorded sermon played back through vMix.
 *
 * SPEC INVARIANT 3 says the SRT sits beside the video and "vMix loads it at
 * playback" — but vMix's Video input has no sidecar-SRT support, so something
 * has to drive them. This is that something.
 *
 * Position-driven, not clock-driven: every tick asks vMix where the file is and
 * shows whichever cue spans that millisecond. Pause, seek and restart therefore
 * need no handling of their own.
 *
 * Deliberately does NOT go through CaptionQueue. The queue schedules against
 * `sessionEpoch + audioStartMs + delayMs`, which assumes time only moves
 * forward at one speed — true of a live broadcast, false of a projector an
 * operator can scrub backwards.
 */

export interface PlayArgs {
  /** Video path or service id. */
  ref: string;
  /** GUID of the vMix input playing the file. Never an input number. */
  input: string;
  /** vMix web controller. */
  vmixUrl?: string | undefined;
  /** Drive a GT title instead of the browser overlay. */
  captionInput?: string | undefined;
  /** Show Gujarati above English on the overlay. */
  lines?: 'both' | 'en';
  token?: string | undefined;
  pollIntervalMs?: number;
}

/** The segment covering this instant, or undefined in the gap between cues. */
export function findSegmentAt(segments: Segment[], positionMs: number): Segment | undefined {
  let low = 0;
  let high = segments.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (positionMs < segment.startMs) high = mid - 1;
    else if (positionMs >= segment.endMs) low = mid + 1;
    else return segment;
  }
  return undefined;
}

export function toCaptionLine(segment: Segment): CaptionLine {
  return {
    id: `cue-${segment.index}`,
    original: segment.original,
    translation: segment.translation,
    audioStartMs: segment.startMs,
    audioEndMs: segment.endMs,
    speaker: segment.speaker,
  };
}

export interface PlayDriverOptions {
  segments: Segment[];
  adapter: OutputAdapter;
  inputGuid: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * One poll: read the position, show or clear.
 *
 * Split out from the loop so it can be driven a tick at a time in tests, the
 * same way CaptionQueue.tick is.
 */
export class PlayDriver {
  private readonly options: PlayDriverOptions;
  private readonly fetchImpl: typeof fetch;
  private shownId: string | undefined;
  private warnedUnreachable = false;

  constructor(options: PlayDriverOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The cue currently on screen, for tests and for the status line. */
  get showing(): string | undefined {
    return this.shownId;
  }

  async tick(): Promise<void> {
    let xml: string;
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/api/`);
      if (!response.ok) throw new Error(`state read failed: ${response.status}`);
      xml = await response.text();
    } catch (err) {
      // Never stop polling: playback carries on regardless, and vMix coming
      // back should bring captions back with it.
      if (!this.warnedUnreachable) {
        warn(`vMix unreachable (${(err as Error).message}) — still trying`);
        this.warnedUnreachable = true;
      }
      return;
    }
    this.warnedUnreachable = false;

    const position = extractInputPosition(xml, this.options.inputGuid);
    if (!position) {
      await this.clear();
      return;
    }

    const segment = findSegmentAt(this.options.segments, position.positionMs);
    if (!segment) {
      await this.clear();
      return;
    }

    const line = toCaptionLine(segment);
    // Re-showing the same cue every 250ms would restart the overlay's fade.
    if (line.id === this.shownId) return;
    this.shownId = line.id;
    await this.options.adapter.show(line);
  }

  private async clear(): Promise<void> {
    if (this.shownId === undefined) return;
    this.shownId = undefined;
    await this.options.adapter.clear();
  }
}

export async function runPlay(
  args: PlayArgs,
  config: AppConfig,
  prisma: PrismaClient,
): Promise<void> {
  const service = await resolveServiceRef(prisma, args.ref);
  const rows = await loadSegments(prisma, service.id);
  if (rows.length === 0) throw new Error('this service has no cues — run `ingest` first');

  const segments = toExportSegments(rows, service.trimStartMs);
  const baseUrl = (args.vmixUrl ?? 'http://127.0.0.1:8088').replace(/\/+$/, '');
  const token = args.token;

  // The browser overlay is the default: its styling is version-controlled and
  // it renders in the same Chromium vMix embeds. The GT title is there for a
  // night when the Browser input misbehaves.
  const overlay = new BrowserAdapter('venue');
  const gt = args.captionInput
    ? new VmixAdapter({ inputGuid: args.captionInput, baseUrl })
    : undefined;
  const adapter: OutputAdapter = gt ?? overlay;

  const server = new BridgeServer({
    host: config.server.host,
    port: config.server.port,
    overlay,
    token,
  });
  await server.start();

  const driver = new PlayDriver({ segments, adapter, inputGuid: args.input, baseUrl });
  const intervalMs = args.pollIntervalMs ?? 250;

  info('');
  info(`${segments.length} cues loaded for ${service.videoPath}`);
  if (gt) {
    info(`driving vMix GT title ${args.captionInput}`);
  } else {
    const query = args.lines === 'both' ? '&lines=both' : '';
    info(
      `overlay: http://${config.server.host}:${config.server.port}/overlay?output=venue${
        token ? `&token=${token}` : ''
      }${query}`,
    );
  }
  info('Point a vMix Browser input at that URL. Ctrl+C to stop.');

  const timer = setInterval(() => {
    void driver.tick().catch((err: unknown) => {
      warn(`play: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);

  await new Promise<void>((resolvePromise) => {
    const shutdown = async () => {
      info('stopping…');
      clearInterval(timer);
      await adapter.clear();
      await server.stop();
      resolvePromise();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}
