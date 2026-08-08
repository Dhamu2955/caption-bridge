import { describe, expect, it } from 'vitest';

import { LineBuilder } from '../src/live/pipeline/lineBuilder.js';
import { SonioxRealtimeClient } from '../src/live/soniox/client.js';
import { buildCaptureArgs, rmsLevel } from '../src/live/capture.js';
import { VmixAdapter, extractTextField } from '../src/live/adapters/vmix.js';
import { outputConfigs } from '../src/live/outputs.js';
import { parseConfig } from '../src/config.js';
import type { SonioxToken } from '../src/soniox/types.js';

const final = (text: string, startMs: number, endMs: number): SonioxToken => ({
  text,
  start_ms: startMs,
  end_ms: endMs,
  is_final: true,
  translation_status: 'original',
  speaker: '1',
});

const translated = (text: string): SonioxToken => ({
  text,
  start_ms: 0,
  end_ms: 0,
  is_final: true,
  translation_status: 'translation',
  speaker: '1',
});

describe('LineBuilder', () => {
  it('ignores non-final tokens entirely (INVARIANT 4 rule 1)', () => {
    const builder = new LineBuilder();
    const lines = builder.push([
      { text: 'partial', start_ms: 0, end_ms: 500, is_final: false },
      { text: '<end>', is_final: true },
    ]);
    expect(lines).toEqual([]);
  });

  it('exposes non-final text as preview only, never as a line', () => {
    const builder = new LineBuilder();
    builder.push([{ text: 'half a thought', start_ms: 0, end_ms: 400, is_final: false }]);
    expect(builder.previewText()).toBe('half a thought');
    expect(builder.flush()).toEqual([]);
  });

  /**
   * Found on a real sermon: a third of the captions went out in Gujarati.
   *
   * Soniox sends a run's translation shortly after its speech, and always
   * before the endpoint that closes it. But the overflow flush does not wait
   * for an endpoint — so speech that ran past `maxBufferMs` was emitted alone,
   * `buildSegments` had nothing to pair it with and fell back to the original,
   * and the English arrived moments later into an emptied buffer and was lost.
   */
  describe('speech that outruns its translation', () => {
    /** 12 seconds of speech with no endpoint and no translation yet. */
    const longRun = (): SonioxToken[] => [
      final('સર્વોપરી', 0, 4000),
      final(' સર્વાવતારી', 4000, 8000),
      final(' પૂર્ણ પુરુષોત્તમ', 8000, 12_000),
    ];

    it('holds the speech rather than captioning it in Gujarati', () => {
      const builder = new LineBuilder();
      // Well past maxBufferMs, but the translation has not arrived.
      expect(builder.push(longRun())).toEqual([]);
    });

    it('emits it in English once the translation catches up', () => {
      const builder = new LineBuilder();
      builder.push(longRun());

      const lines = builder.push([
        translated('The supreme'),
        translated(', the incarnated one.'),
        { text: '<end>', is_final: true },
      ]);

      // A 12-second run is split across several captions by maxSegmentMs; what
      // matters is that the English arrived and no Gujarati leaked into it.
      expect(lines.length).toBeGreaterThan(0);
      const english = lines.map((line) => line.translation).join(' ');
      expect(english).toContain('The supreme');
      expect(english).toContain('incarnated');
      expect(english).not.toMatch(/[઀-૿]/);
    });

    it('does not lose the English when an overflow lands mid-run', () => {
      const builder = new LineBuilder();
      // A completed pair, then more speech still awaiting translation.
      builder.push([final('એક', 0, 4000), translated('One.')]);
      const lines = builder.push([final(' બે', 4000, 12_000)]);

      // The finished pair goes out...
      expect(lines).toHaveLength(1);
      expect(lines[0]?.translation).toBe('One.');

      // ...and the unfinished speech is still held, not discarded.
      const rest = builder.push([translated('Two.'), { text: '<end>', is_final: true }]);
      expect(rest).toHaveLength(1);
      expect(rest[0]?.translation).toBe('Two.');
    });

    it('gives up and captions in Gujarati rather than never captioning at all', () => {
      const builder = new LineBuilder({ maxUntranslatedMs: 10_000 });
      const lines = builder.push([
        final('એક', 0, 6000),
        final(' બે', 6000, 14_000),
      ]);
      // Past the point of waiting: a caption in the wrong language beats none.
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.map((line) => line.translation).join(' ')).toContain('એક');
    });
  });

  it('emits a line when an endpoint token arrives', () => {
    const builder = new LineBuilder();
    const lines = builder.push([
      final('આજે', 0, 800),
      final(' વાત', 800, 2000),
      translated('Today'),
      translated(' we talk.'),
      { text: '<end>', is_final: true },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.translation).toBe('Today we talk.');
    expect(lines[0]?.audioStartMs).toBe(0);
    expect(lines[0]?.audioEndMs).toBe(2000);
  });

  it('takes timing from the spoken run, never from the zeroed translation', () => {
    const builder = new LineBuilder();
    const lines = builder.push([
      final('ભક્તિ', 40_000, 42_000),
      translated('Devotion.'),
      { text: '<end>', is_final: true },
    ]);
    expect(lines[0]?.audioStartMs).toBe(40_000);
  });

  it('flushes without an endpoint once the buffer spans maxBufferMs', () => {
    const builder = new LineBuilder({ maxBufferMs: 3000 });
    expect(builder.push([final('એક', 0, 1000), translated('One.')])).toEqual([]);
    const lines = builder.push([final(' બે', 1000, 3500), translated(' Two.')]);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('gives every line a distinct id', () => {
    const builder = new LineBuilder();
    const first = builder.push([final('એક.', 0, 2000), translated('One.'), { text: '<end>', is_final: true }]);
    const second = builder.push([final('બે.', 3000, 5000), translated('Two.'), { text: '<end>', is_final: true }]);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });
});

describe('realtime client config frame', () => {
  const client = new SonioxRealtimeClient({
    apiKey: 'k',
    model: 'stt-rt-v5',
    sampleRate: 16000,
    languageHints: ['gu', 'en'],
    targetLanguage: 'en',
  });

  it('never enables non-final output', () => {
    expect(client.buildConfigMessage()['include_nonfinal']).toBe(false);
  });

  it('enables endpoint detection, which the async API does not have', () => {
    expect(client.buildConfigMessage()['enable_endpoint_detection']).toBe(true);
  });

  it('matches the documented request shape', () => {
    expect(client.buildConfigMessage()).toMatchObject({
      api_key: 'k',
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['gu', 'en'],
      translation: { type: 'one_way', target_language: 'en' },
    });
  });

  it('drops audio rather than buffering it while disconnected (§8)', () => {
    expect(client.sendAudio(Buffer.alloc(320))).toBe(false);
  });
});

describe('audio capture', () => {
  it('builds Windows dshow arguments for a virtual cable', () => {
    const args = buildCaptureArgs({
      device: 'CABLE Output (VB-Audio Virtual Cable)',
      format: 'dshow',
    });
    expect(args).toContain('dshow');
    expect(args).toContain('audio=CABLE Output (VB-Audio Virtual Cable)');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args.join(' ')).toContain('-ar 16000');
    expect(args.join(' ')).toContain('pcm_s16le');
  });

  it('builds macOS avfoundation arguments for BlackHole', () => {
    const args = buildCaptureArgs({ device: ':BlackHole 2ch', format: 'avfoundation' });
    expect(args).toContain('avfoundation');
    expect(args).toContain(':BlackHole 2ch');
  });

  it('adds the avfoundation colon to a bare device name', () => {
    // The device list — and so the dropdown built from it — yields bare names.
    // avfoundation reads "[video]:[audio]", so without the colon ffmpeg looks
    // for a camera called "BlackHole 2ch" and exits with "Video device not
    // found" the moment someone presses Start.
    const args = buildCaptureArgs({ device: 'BlackHole 2ch', format: 'avfoundation' });
    expect(args).toContain(':BlackHole 2ch');
    expect(args).not.toContain('BlackHole 2ch');
  });

  it('leaves an index pair alone', () => {
    const args = buildCaptureArgs({ device: '0:1', format: 'avfoundation' });
    expect(args).toContain('0:1');
  });

  it('plays a recording in at its own speed', () => {
    const args = buildCaptureArgs({ device: './test-clip.mp4', format: 'file' });
    // -re is the whole point. Without it ffmpeg reads as fast as the disk
    // allows, a 69-minute sermon arrives in seconds, and a pipeline whose job
    // is timing has been tested against nothing.
    expect(args).toContain('-re');
    expect(args).toContain('./test-clip.mp4');
    // Not a capture device, so no -f before the input.
    expect(args.join(' ')).not.toContain('-f file');
    // Still the same PCM the rest of the pipeline expects.
    expect(args.join(' ')).toContain('-ar 16000');
    expect(args.join(' ')).toContain('pcm_s16le');
  });

  it('can loop a recording for a longer rehearsal', () => {
    const args = buildCaptureArgs({ device: './clip.mp4', format: 'file', loop: true });
    expect(args.join(' ')).toContain('-stream_loop -1');
  });

  it('reports silence as zero level — this is what catches a dead cable', () => {
    expect(rmsLevel(Buffer.alloc(3840))).toBe(0);
  });

  it('reports a non-zero level for real audio', () => {
    const chunk = Buffer.alloc(3840);
    for (let i = 0; i < chunk.length / 2; i++) chunk.writeInt16LE(8000, i * 2);
    expect(rmsLevel(chunk)).toBeGreaterThan(0.2);
  });
});

describe('vMix adapter', () => {
  it('appends .Text to the field name, without which vMix silently ignores it', () => {
    const adapter = new VmixAdapter({ inputGuid: 'guid-1', field: 'Caption' });
    expect(adapter.selectedName()).toBe('Caption.Text');
  });

  it('sends SetText by GUID, never by input number', async () => {
    const calls: string[] = [];
    const adapter = new VmixAdapter({
      inputGuid: 'abc-123',
      field: 'Caption',
      minIntervalMs: 0,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await adapter.show({
      id: 'l1',
      original: 'ગુ',
      translation: 'Hello',
      audioStartMs: 0,
      audioEndMs: 1000,
      speaker: undefined,
    });
    expect(calls[0]).toContain('Function=SetText');
    expect(calls[0]).toContain('Input=abc-123');
    expect(calls[0]).toContain(encodeURIComponent('Caption.Text'));
    expect(calls[0]).toContain('Value=Hello');
  });

  it('rate-limits SetText — titles chug under heavier load', async () => {
    const waits: number[] = [];
    const adapter = new VmixAdapter({
      inputGuid: 'g',
      minIntervalMs: 200,
      now: () => 1000,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    });
    const line = {
      id: 'l',
      original: 'x',
      translation: 'y',
      audioStartMs: 0,
      audioEndMs: 1,
      speaker: undefined,
    };
    await adapter.show(line);
    await adapter.show(line);
    // Clock frozen, so the second call must have waited the full interval.
    expect(waits.at(-1)).toBe(200);
  });

  describe('readback verification', () => {
    // §4: a mistyped SelectedName still returns 200. Only the state XML tells
    // the truth, so this is the check that actually catches it.
    const xml = `<vmix><inputs>
      <input key="abc-123" number="1" title="Captions">
        <text name="Caption.Text">God&apos;s discourse &amp; stories</text>
        <text name="Other.Text">nope</text>
      </input>
      <input key="def-456" number="2"><text name="Caption.Text">wrong input</text></input>
    </inputs></vmix>`;

    it('extracts the field from the right input', () => {
      expect(extractTextField(xml, 'abc-123', 'Caption')).toBe("God's discourse & stories");
    });

    it('does not read another input with the same field name', () => {
      expect(extractTextField(xml, 'def-456', 'Caption')).toBe('wrong input');
    });

    it('returns undefined for a field that does not exist — the mistyped case', () => {
      expect(extractTextField(xml, 'abc-123', 'Captoin')).toBeUndefined();
    });

    it('verify() compares against what vMix actually holds', async () => {
      const adapter = new VmixAdapter({
        inputGuid: 'abc-123',
        field: 'Caption',
        minIntervalMs: 0,
        fetchImpl: (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch,
      });
      expect(await adapter.verify("God's discourse & stories")).toBe(true);
      expect(await adapter.verify('something else')).toBe(false);
    });
  });
});

describe('output table (INVARIANT 7)', () => {
  const config = parseConfig({
    live: { delayAssemblyMs: 4000, delayReviewMs: 25000, minDisplayMs: 1500, lateSkipMs: 2000 },
  });
  const outputs = outputConfigs(config);

  it('gives the reviewed path delayA + delayB, never a single global constant', () => {
    expect(outputs.stream.delayMs).toBe(29_000);
    expect(outputs.stream.reviewed).toBe(true);
  });

  it('gives every single-composite output delay A only', () => {
    expect(outputs.reviewer.delayMs).toBe(4000);
    expect(outputs.venue.delayMs).toBe(4000);
    expect(outputs.overflow.delayMs).toBe(4000);
  });

  it('leaves the stub undelayed for development', () => {
    expect(outputs.stub.delayMs).toBe(0);
  });

  it('applies the 1500ms floor to every output', () => {
    for (const output of Object.values(outputs)) {
      expect(output.minDisplayMs).toBe(1500);
    }
  });
});

describe('review window length', () => {
  it('defaults to three minutes, so correcting a line is realistic', () => {
    // At 25 seconds a reviewer can only drop; reading the Gujarati, judging
    // the English and typing a fix does not fit.
    const outputs = outputConfigs(parseConfig({}));
    expect(outputs.stream.delayMs).toBe(184_000);
  });

  it('carries a longer window straight through to the reviewed output', () => {
    const config = parseConfig({ live: { delayAssemblyMs: 4000, delayReviewMs: 600_000 } });
    expect(outputConfigs(config).stream.delayMs).toBe(604_000);
  });

  it('leaves unreviewed outputs on assembly delay however long review gets', () => {
    // The venue screen cannot be ten minutes behind the room.
    const config = parseConfig({ live: { delayAssemblyMs: 4000, delayReviewMs: 600_000 } });
    expect(outputConfigs(config).venue.delayMs).toBe(4000);
  });

  it('refuses a window past ten minutes', () => {
    expect(() => parseConfig({ live: { delayReviewMs: 600_001 } })).toThrow(/10 minutes/);
  });
});
