import { describe, expect, it } from 'vitest';

import { measureChannels, ProbeError } from '../src/live/probe.js';
import { buildCaptureArgs, channelFilter } from '../src/live/capture.js';

/** Interleaved s16le, one array of samples (−1..1) per channel. */
function interleave(channels: number[][]): Buffer {
  const frames = channels[0]?.length ?? 0;
  const buffer = Buffer.alloc(frames * channels.length * 2);
  for (let frame = 0; frame < frames; frame++) {
    channels.forEach((samples, channel) => {
      const value = Math.round((samples[frame] ?? 0) * 32767);
      buffer.writeInt16LE(value, (frame * channels.length + channel) * 2);
    });
  }
  return buffer;
}

const tone = (amplitude: number, frames = 400) =>
  Array.from({ length: frames }, (_, i) => amplitude * Math.sin((i / frames) * Math.PI * 8));

describe('measuring each channel separately', () => {
  it('finds the one channel carrying the speaker', () => {
    // The whole diagnosis, in one assertion: a capture card presenting four
    // inputs with the sermon on the first and nothing patched into the rest.
    const pcm = interleave([tone(0.5), [], [], []].map((c) => (c.length ? c : new Array(400).fill(0))));
    const levels = measureChannels(pcm, 4);

    expect(levels).toHaveLength(4);
    expect(levels[0]!.channel).toBe(1);
    expect(levels[0]!.peak).toBeGreaterThan(0.4);
    for (const level of levels.slice(1)) {
      expect(level.peak).toBe(0);
      expect(level.peakDb).toBeNull();
    }
  });

  it('does not mix the channels up', () => {
    const pcm = interleave([tone(0.1), tone(0.8)]);
    const [first, second] = measureChannels(pcm, 2);
    expect(first!.peak).toBeLessThan(0.2);
    expect(second!.peak).toBeGreaterThan(0.7);
  });

  it('reports digital silence as silence, not as −infinity dB', () => {
    const levels = measureChannels(interleave([new Array(200).fill(0)]), 1);
    expect(levels[0]!.rms).toBe(0);
    expect(levels[0]!.peakDb).toBeNull();
  });

  it('measures nothing rather than throwing on an empty capture', () => {
    const levels = measureChannels(Buffer.alloc(0), 2);
    expect(levels.map((level) => level.rms)).toEqual([0, 0]);
  });

  it('refuses a channel count that cannot be true', () => {
    expect(() => measureChannels(Buffer.alloc(4), 0)).toThrow(ProbeError);
  });
});

describe('taking one channel instead of averaging them', () => {
  it('is off by default, so a virtual cable behaves as it always has', () => {
    expect(channelFilter(undefined)).toBeUndefined();
    expect(buildCaptureArgs({ device: 'BlackHole 2ch', format: 'avfoundation' })).not.toContain('-af');
  });

  it('indexes channels from 1, the way every mixer in the building does', () => {
    expect(channelFilter(1)).toBe('pan=mono|c0=c0');
    expect(channelFilter(9)).toBe('pan=mono|c0=c8');
  });

  it('puts the filter before the output, where ffmpeg reads it', () => {
    const args = buildCaptureArgs({
      device: 'Blackmagic UltraStudio',
      format: 'avfoundation',
      channel: 1,
    });
    expect(args.join(' ')).toContain('-i :Blackmagic UltraStudio -af pan=mono|c0=c0');
    // -ac 1 still follows, so a filter that ever yields more than one channel
    // cannot reach Soniox as something other than mono.
    expect(args.indexOf('-af')).toBeLessThan(args.indexOf('-ac'));
  });

  it('works for a recording as well as a device', () => {
    const args = buildCaptureArgs({ device: './clip.mp4', format: 'file', channel: 2 });
    expect(args).toContain('pan=mono|c0=c1');
    expect(args).toContain('-re');
  });

  it('refuses a channel number that is not one', () => {
    for (const channel of [0, -1, 1.5]) {
      expect(() => channelFilter(channel)).toThrow(/whole number/);
    }
  });
});
