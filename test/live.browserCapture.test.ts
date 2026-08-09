import { describe, expect, it } from 'vitest';

import { AudioCapture, buildCaptureArgs } from '../src/live/capture.js';

/**
 * Browser capture is the one source with no process behind it: the page holds
 * the microphone and pushes PCM over a WebSocket. What has to stay true is that
 * everything downstream cannot tell the difference.
 */
describe('capturing from a browser', () => {
  function capture(): AudioCapture {
    return new AudioCapture({ device: 'a browser', format: 'browser', chunkBytes: 8 });
  }

  it('spawns nothing — there is no ffmpeg in this path', () => {
    const source = capture();
    source.start();
    // No child process to stop, and stopping must not throw for want of one.
    expect(() => source.stop()).not.toThrow();
  });

  it('re-frames whatever the page sends into the pacing everything expects', () => {
    const source = capture();
    const chunks: Buffer[] = [];
    source.on('audio', (chunk) => chunks.push(chunk));
    source.start();

    // Three ragged writes, worth two and a half chunks at 8 bytes each.
    source.push(Buffer.alloc(5, 1));
    source.push(Buffer.alloc(9, 1));
    source.push(Buffer.alloc(6, 1));

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length === 8)).toBe(true);
  });

  it('emits a level for every chunk, so the meter and the alarm still work', () => {
    const source = capture();
    const levels: number[] = [];
    source.on('level', (level) => levels.push(level));
    source.start();

    source.push(Buffer.alloc(8, 0));
    const loud = Buffer.alloc(8);
    loud.writeInt16LE(20_000, 0);
    loud.writeInt16LE(20_000, 2);
    loud.writeInt16LE(20_000, 4);
    loud.writeInt16LE(20_000, 6);
    source.push(loud);

    expect(levels).toHaveLength(2);
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeGreaterThan(0.5);
  });

  it('ignores pushes when the session is fed some other way', () => {
    const device = new AudioCapture({ device: 'BlackHole', format: 'avfoundation' });
    const chunks: Buffer[] = [];
    device.on('audio', (chunk) => chunks.push(chunk));
    device.push(Buffer.alloc(4096, 1));
    expect(chunks).toHaveLength(0);
  });

  it('drops a partial chunk on restart rather than gluing it to the next input', () => {
    const source = capture();
    const chunks: Buffer[] = [];
    source.on('audio', (chunk) => chunks.push(chunk));

    source.start();
    source.push(Buffer.alloc(5, 1));
    source.start();
    source.push(Buffer.alloc(5, 2));

    // 5 + 5 would make a chunk if the carry survived; it must not.
    expect(chunks).toHaveLength(0);
  });
});

describe('the other formats are unaffected', () => {
  it('still builds ffmpeg arguments for a real device', () => {
    const args = buildCaptureArgs({ device: 'BlackHole 2ch', format: 'avfoundation' });
    expect(args).toContain('avfoundation');
    expect(args).toContain(':BlackHole 2ch');
  });
});
