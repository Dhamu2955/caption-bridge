import { execFile } from 'node:child_process';

import { defaultFormat, type CaptureFormat } from './capture.js';

/**
 * Enumerate audio input devices by actually running ffmpeg.
 *
 * `listDevicesCommand` in capture.ts returns a command for a human to type;
 * this parses the result, so the control page can offer a dropdown instead of
 * asking a volunteer to transcribe a device name character for character.
 *
 * ffmpeg writes its device list to STDERR and exits non-zero on all three
 * platforms — that is the normal, successful outcome here, not a failure.
 */

export interface AudioDevice {
  /** Exactly the string `--device` needs. */
  name: string;
  /** True when this looks like a virtual cable or a mixer bus. */
  likelyBus: boolean;
}

export type ExecImpl = (command: string, args: string[]) => Promise<{ stderr: string }>;

const defaultExec: ExecImpl = (command, args) =>
  new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 10_000 }, (_error, _stdout, stderr) => {
      // Never rejects: ffmpeg exits non-zero after listing devices, by design.
      resolvePromise({ stderr: stderr ?? '' });
    });
  });

/**
 * INVARIANT 6 is the biggest accuracy lever in the project, and a dropdown
 * makes picking the wrong input effortless. Anything matching this is the
 * likely correct answer and gets flagged as such in the UI.
 */
const BUS_HINTS = [
  'cable output',
  'vb-audio',
  'voicemeeter',
  'blackhole',
  'soundflower',
  'loopback',
  'bus',
];

export function looksLikeBus(name: string): boolean {
  const lower = name.toLowerCase();
  return BUS_HINTS.some((hint) => lower.includes(hint));
}

/** `[dshow @ ...] "CABLE Output (VB-Audio Virtual Cable)" (audio)` */
export function parseDshowDevices(stderr: string): string[] {
  const names: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    // Only the (audio) entries; a dshow listing carries video devices too.
    const match = /"([^"]+)"\s*\(audio\)/i.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/**
 * avfoundation lists video devices first, then audio, under separate headings —
 * so the heading has to be tracked or every camera ends up in the dropdown.
 */
export function parseAvfoundationDevices(stderr: string): string[] {
  const names: string[] = [];
  let inAudio = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = /\[\d+\]\s+(.+?)\s*$/.exec(line.replace(/^\[[^\]]*\]\s*/, ''));
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/** `ffmpeg -sources pulse` writes one device per line as `name [description]`. */
export function parsePulseDevices(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^auto detected|^devices|^sources/i.test(trimmed)) continue;
    const match = /^\*?\s*([^\s\[]+)/.exec(trimmed);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

export async function listAudioDevices(
  format: CaptureFormat = defaultFormat(),
  options: { execImpl?: ExecImpl; ffmpegPath?: string } = {},
): Promise<AudioDevice[]> {
  const exec = options.execImpl ?? defaultExec;
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';

  let names: string[];
  if (format === 'dshow') {
    const { stderr } = await exec(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    names = parseDshowDevices(stderr);
  } else if (format === 'avfoundation') {
    const { stderr } = await exec(ffmpeg, [
      '-f',
      'avfoundation',
      '-list_devices',
      'true',
      '-i',
      '',
    ]);
    names = parseAvfoundationDevices(stderr);
  } else {
    const { stderr } = await exec(ffmpeg, ['-sources', format]);
    names = parsePulseDevices(stderr);
  }

  const seen = new Set<string>();
  const devices: AudioDevice[] = [];
  for (const name of names) {
    if (name.trim() === '' || seen.has(name)) continue;
    seen.add(name);
    devices.push({ name, likelyBus: looksLikeBus(name) });
  }
  return devices;
}
