import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class FfmpegError extends Error {}

export interface ExtractOptions {
  /** Defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string;
  sampleRate?: number;
  channels?: number;
}

/**
 * Video/audio in → 16 kHz mono PCM WAV out (§4 phase 1, step 1).
 *
 * ffmpeg streams straight to disk; nothing is buffered in this process, so a
 * 90-minute file costs no more memory than a 90-second one.
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
  options: ExtractOptions = {},
): Promise<string> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const sampleRate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-vn',
    '-map', '0:a:0',
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    outputPath,
  ];

  await run(ffmpegPath, args);
  return outputPath;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a runaway ffmpeg must not grow this without limit.
      if (stderr.length < 8000) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${command} not found on PATH — install it (brew install ffmpeg)`
          : err.message;
      rejectPromise(new FfmpegError(hint));
    });

    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new FfmpegError(`${command} exited with code ${code}\n${stderr.trim()}`));
    });
  });
}

/** Scratch directory for the intermediate WAV; caller disposes it. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sermon-captions-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
