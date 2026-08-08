import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

/**
 * Audio capture → PCM s16le 16 kHz mono.
 *
 * INVARIANT 5/6: the device named here must be a vMix bus carrying the
 * speaker's mic ONLY, tapped before the video delay. Feeding it Master gives
 * Soniox music, VT audio and congregation noise.
 *
 * Platform device syntax:
 *   Windows  ffmpeg -f dshow      -i audio="CABLE Output (VB-Audio Virtual Cable)"
 *   macOS    ffmpeg -f avfoundation -i ":BlackHole 2ch"
 */

/**
 * `file` is not a capture device — it plays a recording in at the speed it was
 * recorded, so the whole live path can be exercised without a microphone, a
 * mixer, or anyone speaking. Everything downstream is identical: the same
 * chunks, the same Soniox session, the same queue and delays.
 *
 * It is for testing and rehearsal. A real service uses a device.
 */
export type CaptureFormat = 'dshow' | 'avfoundation' | 'pulse' | 'alsa' | 'file';

export interface CaptureOptions {
  /** Device name as ffmpeg expects it for the chosen format. */
  device: string;
  format?: CaptureFormat;
  sampleRate?: number;
  ffmpegPath?: string;
  /** Bytes per emitted chunk. 3840 = 120ms at 16kHz mono s16le, matching the
   *  pacing used for replay in docs/architecture.mermaid. */
  chunkBytes?: number;
  /** `file` format only: start again at the end, for a long rehearsal. */
  loop?: boolean;
}

export interface CaptureEvents {
  audio: [Buffer];
  /** RMS level 0–1, for the operator's "is the cable actually live" meter. */
  level: [number];
  error: [Error];
  close: [number | null];
}

export function defaultFormat(): CaptureFormat {
  if (process.platform === 'win32') return 'dshow';
  if (process.platform === 'darwin') return 'avfoundation';
  return 'pulse';
}

/**
 * avfoundation takes `"[video]:[audio]"`, so a bare device name is read as a
 * *video* device and fails with "Video device not found". The device list and
 * the dropdown built from it hand over bare names, so the colon is added here
 * rather than expected of every caller — while leaving an explicit `":Name"`
 * or `"0:1"` alone, since the docs tell people to write it that way.
 */
export function avfoundationInput(device: string): string {
  return device.includes(':') ? device : `:${device}`;
}

export function buildCaptureArgs(options: CaptureOptions): string[] {
  const format = options.format ?? defaultFormat();
  const sampleRate = options.sampleRate ?? 16000;

  const output = [
    '-ac', '1',
    '-ar', String(sampleRate),
    '-acodec', 'pcm_s16le',
    '-f', 's16le',
    '-',
  ];

  if (format === 'file') {
    // -re paces the read at the recording's own speed. Without it ffmpeg reads
    // as fast as the disk allows and a 69-minute sermon arrives in seconds,
    // which tells you nothing about a pipeline whose whole job is timing.
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      ...(options.loop ? ['-stream_loop', '-1'] : []),
      '-re',
      '-i', options.device,
      ...output,
    ];
  }

  const input =
    format === 'dshow'
      ? `audio=${options.device}`
      : format === 'avfoundation'
        ? avfoundationInput(options.device)
        : options.device;

  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', format,
    '-i', input,
    ...output,
  ];
}

/** RMS of a signed 16-bit little-endian buffer, normalised to 0–1. */
export function rmsLevel(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = chunk.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

export class AudioCapture extends EventEmitter<CaptureEvents> {
  private options: CaptureOptions;
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private carry: Buffer = Buffer.alloc(0);

  constructor(options: CaptureOptions) {
    super();
    this.options = options;
  }

  /** Point at a different input. Takes effect on the next `start()`. */
  setDevice(device: string): void {
    this.options = { ...this.options, device };
  }

  get device(): string {
    return this.options.device;
  }

  start(): void {
    // Stale audio from a previous device must not be prepended to the new one.
    this.carry = Buffer.alloc(0);
    const chunkBytes = this.options.chunkBytes ?? 3840;
    const child = spawn(this.options.ffmpegPath ?? 'ffmpeg', buildCaptureArgs(this.options), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', (data: Buffer) => {
      this.carry = this.carry.length === 0 ? data : Buffer.concat([this.carry, data]);
      // Emit fixed-size chunks so pacing is predictable rather than following
      // whatever ffmpeg happens to flush.
      while (this.carry.length >= chunkBytes) {
        const chunk = this.carry.subarray(0, chunkBytes);
        this.carry = this.carry.subarray(chunkBytes);
        this.emit('audio', chunk);
        this.emit('level', rmsLevel(chunk));
      }
    });

    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < 4000) stderr += data.toString();
    });

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.emit(
        'error',
        new Error(
          code === 'ENOENT'
            ? 'ffmpeg not found on PATH'
            : `${err.message}${stderr ? `\n${stderr.trim()}` : ''}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        this.emit('error', new Error(`ffmpeg capture exited ${code}: ${stderr.trim()}`));
      }
      this.emit('close', code);
    });
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

/** `ffmpeg -f dshow -list_devices true -i dummy` — for finding the cable name. */
export function listDevicesCommand(format: CaptureFormat = defaultFormat()): string {
  if (format === 'dshow') return 'ffmpeg -list_devices true -f dshow -i dummy';
  if (format === 'avfoundation') return 'ffmpeg -f avfoundation -list_devices true -i ""';
  return 'ffmpeg -sources pulse';
}
