import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { formatTimecode } from '../srt/format.js';
import type { CaptionLine } from './types.js';
import { warn } from '../util/log.js';

/**
 * Write an SRT while the service is running.
 *
 * A live service used to leave no subtitle file behind at all — captions went
 * to screens and to YouTube and then were gone, and putting them on the
 * recording afterwards meant ingesting the video and paying Soniox a second
 * time for words it had already transcribed. A prototype of this same job
 * writes one as it goes, and it is close to free: the lines already exist and
 * already carry audio timestamps.
 *
 * Appended cue by cue rather than written at the end, so a session that dies
 * mid-sermon still leaves everything up to that point. The file is only as good
 * as the run: it holds what actually went out, corrections and all, and stops
 * wherever the run stopped.
 *
 * Timestamps are audio positions, which is what SRT wants — but they are
 * positions in the *captured audio*, so they line up with the recording only if
 * capture started with it. Note that on the tin rather than pretend otherwise.
 */
export class LiveSrtWriter {
  readonly path: string;
  private index = 0;
  private lastEndMs = 0;
  private failed = false;

  constructor(path: string) {
    this.path = resolve(path);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch (err) {
      this.failed = true;
      warn(`live subtitles: ${(err as Error).message}`);
    }
  }

  /** A name that sorts by date and cannot collide with the last service. */
  static pathFor(directory: string, at: Date): string {
    const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return join(directory, `live-${stamp}.en.srt`);
  }

  /**
   * Append one released line.
   *
   * Never throws. A full disk must not take a broadcast down — the subtitles
   * are a by-product, and the screens are the job.
   */
  add(line: CaptionLine): void {
    if (this.failed || !line.translation.trim()) return;

    // Cues must not overlap or run backwards. A line whose audio window starts
    // before the last one ended is nudged rather than dropped: out-of-order
    // timings come from the queue releasing a correction, and the text is still
    // wanted.
    const startMs = Math.max(line.audioStartMs, this.lastEndMs);
    const endMs = Math.max(line.audioEndMs, startMs + 500);

    this.index++;
    const cue =
      `${this.index}\n` +
      `${formatTimecode(startMs)} --> ${formatTimecode(endMs)}\n` +
      `${line.translation.trim()}\n\n`;

    try {
      appendFileSync(this.path, cue, 'utf8');
      this.lastEndMs = endMs;
    } catch (err) {
      // Said once. A failing disk would otherwise print per caption for the
      // rest of the service.
      this.failed = true;
      warn(`live subtitles stopped: ${(err as Error).message}`);
    }
  }

  get cues(): number {
    return this.index;
  }
}
