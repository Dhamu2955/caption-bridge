import { execFile, spawn } from 'node:child_process';

import { buildInputArgs, defaultFormat, type CaptureFormat } from './capture.js';

/**
 * Listen to an input for a few seconds and report what is actually on it.
 *
 * This exists because of one failure that costs a service and gives no sign of
 * itself: a device that opens cleanly, streams cleanly, and carries the speaker
 * on a channel nobody is taking. Nothing errors. ffmpeg is happy, the session
 * runs, the meter sits near zero and Soniox returns nothing — and the only way
 * to tell that apart from a muted mixer, a pulled cable or a quiet speaker was
 * to guess.
 *
 * So: how many channels the device really has, and the level on each of them,
 * separately. A capture card presenting sixteen channels with the sermon on
 * channel 1 becomes obvious rather than inferred, and the answer is a number
 * per input rather than a judgement about a single mixed meter.
 *
 * Deliberately a separate, short-lived ffmpeg run: it can be pointed at a
 * device while nothing is live, and it cannot disturb a session that is.
 */

export interface ChannelLevel {
  /** 1-based, matching how every mixer and interface in the building counts. */
  channel: number;
  /** RMS over the whole window, 0–1. */
  rms: number;
  /** Loudest single sample, 0–1. Distinguishes quiet from truly dead. */
  peak: number;
  /** dBFS of the peak, or null for digital silence. */
  peakDb: number | null;
}

export interface InputProbe {
  device: string;
  format: CaptureFormat;
  channels: number;
  sampleRateHz: number;
  seconds: number;
  levels: ChannelLevel[];
  /** Channels carrying something, 1-based. Empty means the input is dead. */
  live: number[];
  /** Set when the device opened but every channel was digital silence. */
  silent: boolean;
}

export class ProbeError extends Error {}

/**
 * Anything above this is a real signal rather than a converter's noise floor.
 *
 * −60 dBFS: a line input with nothing patched into it sits below this, and
 * speech that is merely quiet sits well above. The measurement that matters is
 * the comparison *between* channels anyway — one channel at −30 next to fifteen
 * at −90 answers the question on its own.
 */
const LIVE_PEAK = 0.001;

export interface ProbeOptions {
  device: string;
  format?: CaptureFormat | undefined;
  /** How long to listen. Long enough to catch a pause between sentences. */
  seconds?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
}

/** Channel count and sample rate, straight from the device. */
export async function describeInput(options: ProbeOptions): Promise<{
  channels: number;
  sampleRateHz: number;
}> {
  const format = options.format ?? defaultFormat();
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'a:0',
    ...buildInputArgs({ device: options.device, format }),
  ];

  const { stdout, stderr, failed } = await run(options.ffprobePath ?? 'ffprobe', args, 15_000);
  if (failed || stdout.trim() === '') {
    throw new ProbeError(explain(stderr, options.device, format));
  }

  let parsed: { streams?: { channels?: number; sample_rate?: string }[] };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new ProbeError(`could not read what ffprobe said about "${options.device}"`);
  }

  const stream = parsed.streams?.[0];
  if (!stream?.channels) {
    throw new ProbeError(`"${options.device}" reported no audio stream — is it a video-only input?`);
  }
  return {
    channels: stream.channels,
    sampleRateHz: Number(stream.sample_rate ?? 0) || 0,
  };
}

/**
 * Capture every channel side by side and measure each one.
 *
 * The channels are kept apart the whole way — no `-ac 1` anywhere — because
 * mixing them down is precisely the thing being diagnosed.
 */
export async function probeInput(options: ProbeOptions): Promise<InputProbe> {
  const format = options.format ?? defaultFormat();
  const seconds = options.seconds ?? 4;
  const { channels, sampleRateHz } = await describeInput(options);

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    ...buildInputArgs({ device: options.device, format }),
    '-t', String(seconds),
    '-ac', String(channels),
    '-ar', '16000',
    '-acodec', 'pcm_s16le',
    '-f', 's16le',
    '-',
  ];

  const pcm = await capture(options.ffmpegPath ?? 'ffmpeg', args, seconds * 1000 + 20_000);
  if (pcm.data.length === 0) {
    throw new ProbeError(explain(pcm.stderr, options.device, format));
  }

  const levels = measureChannels(pcm.data, channels);
  const live = levels.filter((level) => level.peak >= LIVE_PEAK).map((level) => level.channel);

  return {
    device: options.device,
    format,
    channels,
    sampleRateHz,
    seconds,
    levels,
    live,
    silent: live.length === 0,
  };
}

/**
 * Per-channel RMS and peak from an interleaved s16le buffer.
 *
 * Pure, so the arithmetic that decides "channel 1 has the sermon on it" is
 * testable without a capture card on the desk.
 */
export function measureChannels(pcm: Buffer, channels: number): ChannelLevel[] {
  if (channels < 1) throw new ProbeError('a device with no channels cannot be measured');

  const sums = new Float64Array(channels);
  const peaks = new Float64Array(channels);
  const frames = Math.floor(pcm.length / 2 / channels);

  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = pcm.readInt16LE((frame * channels + channel) * 2) / 32768;
      sums[channel]! += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peaks[channel]!) peaks[channel] = magnitude;
    }
  }

  const levels: ChannelLevel[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const peak = peaks[channel]!;
    levels.push({
      channel: channel + 1,
      rms: frames === 0 ? 0 : Math.sqrt(sums[channel]! / frames),
      peak,
      peakDb: peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null,
    });
  }
  return levels;
}

/** ffmpeg's complaints, turned into something worth reading on a Sunday. */
function explain(stderr: string, device: string, format: CaptureFormat): string {
  const text = stderr.trim();
  if (/not found on PATH|ENOENT/i.test(text)) return 'ffmpeg is not installed on this machine';
  if (/Input\/output error/i.test(text)) {
    return `"${device}" could not be opened — it is listed but not handing over any audio. ` +
      'Something else may already have it open, or it may need its input selected on the device itself.';
  }
  if (/Video device not found|Audio device not found|Cannot find/i.test(text)) {
    return `"${device}" is not there any more — unplugged, renamed, or asleep. Refresh the list.`;
  }
  if (/Operation not permitted|not authorized|permission/i.test(text)) {
    return (
      `macOS is refusing microphone access to the bridge, so "${device}" hands over silence. ` +
      'Grant it under System Settings → Privacy & Security → Microphone, for the terminal ' +
      'the bridge was started from, and start it again.'
    );
  }
  return text === '' ? `"${device}" (${format}) produced nothing at all` : text;
}

function run(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', failed: error !== null });
    });
  });
}

function capture(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ data: Buffer; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';

    // A device that opens and then never delivers would otherwise hang the
    // request that asked about it.
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      rejectPromise(
        new ProbeError(code === 'ENOENT' ? 'ffmpeg is not installed on this machine' : err.message),
      );
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolvePromise({ data: Buffer.concat(chunks), stderr });
    });
  });
}
