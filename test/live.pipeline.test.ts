import { describe, expect, it } from 'vitest';

import { LineBuilder } from '../src/live/pipeline/lineBuilder.js';
import { SonioxRealtimeClient } from '../src/live/soniox/client.js';
import { buildCaptureArgs, rmsLevel } from '../src/live/capture.js';
import { VmixAdapter, extractTextField } from '../src/live/adapters/vmix.js';
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

/**
 * English the speaker used inside a Gujarati sentence.
 *
 * Soniox marks it `none`, not `original`: it is already in the target language,
 * so no translation run is ever emitted for it. Confirmed against a real
 * transcript — "Please turn to page ten" comes back as six `none` tokens with
 * timestamps, followed straight back into Gujarati `original`.
 */
const codeSwitched = (text: string, startMs: number, endMs: number): SonioxToken => ({
  text,
  start_ms: startMs,
  end_ms: endMs,
  is_final: true,
  translation_status: 'none',
  language: 'en',
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

  it('drops non-final text entirely — it is never buffered or returned', () => {
    // The innermost of the four things keeping revisable text off a screen.
    // There is deliberately no way to read it back out of the builder.
    const builder = new LineBuilder();
    expect(
      builder.push([{ text: 'half a thought', start_ms: 0, end_ms: 400, is_final: false }]),
    ).toEqual([]);
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

    it('sends a pair the moment it completes, and holds what is unfinished', () => {
      const builder = new LineBuilder();

      // The pair completes on this push, so it leaves on this push. Waiting
      // for the endpoint here was pure lag — the words were already ready.
      const first = builder.push([final('એક', 0, 4000), translated('One.')]);
      expect(first).toHaveLength(1);
      expect(first[0]?.translation).toBe('One.');

      // Speech with no English yet is held, not shown and not discarded.
      expect(builder.push([final(' બે', 4000, 12_000)])).toEqual([]);

      const rest = builder.push([translated('Two.')]);
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

  it('needs no endpoint at all — a completed pair goes straight out', () => {
    // maxBufferMs is now only the backstop for speech whose translation never
    // arrives; it is not what makes captions appear.
    const builder = new LineBuilder();
    const lines = builder.push([final('એક', 0, 1000), translated('One.')]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.translation).toBe('One.');
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


describe('English the speaker slips into a Gujarati sentence', () => {
  const options = {
    pauseMs: 1200,
    maxChars: 120,
    maxSegmentMs: 20_000,
    minDisplayMs: 1500,
    };

  it('goes out on an overflow flush rather than waiting for a translation', () => {
    // Nothing is coming for it, so waiting meant it sat until
    // maxUntranslatedMs — 30s against a 15s assembly delay, by which point
    // lateSkipMs dropped it. English the speaker actually used, gone.
    const builder = new LineBuilder(options);
    const lines = builder.push([
      final('નમસ્તે.', 0, 1200),
      translated('Hello.'),
      codeSwitched(' Please turn to page ten.', 2000, 9500),
    ]);

    const text = lines.map((line) => line.translation).join(' ');
    expect(text).toContain('Please turn to page ten.');
  });

  it('appears in both tracks, because it is what was said and what to show', () => {
    const builder = new LineBuilder(options);
    const lines = builder.push([
      codeSwitched('Please turn to page ten.', 0, 9000),
      { text: '<end>', is_final: true } as SonioxToken,
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.original).toBe('Please turn to page ten.');
    expect(lines[0]!.translation).toBe('Please turn to page ten.');
  });

  it('still holds Gujarati that has not been translated yet', () => {
    // The fix must not reopen the bug it sits next to: an untranslated run
    // before a code-switched one keeps both back, because emitting out of
    // order would put an English aside on screen ahead of the sentence it
    // interrupted.
    const builder = new LineBuilder(options);
    const lines = builder.push([
      final('આ વાક્ય હજી અનુવાદ થયું નથી.', 0, 8500),
      codeSwitched(' Please turn to page ten.', 8600, 9500),
    ]);
    expect(lines).toEqual([]);
  });
});


describe('the Soniox config message matches the working prototype', () => {
  /**
   * `../soniox_en` has run this job on air for weeks. Where our wire message
   * differed from its, ours was wrong — most of all in sending
   * `endpoint_sensitivity`, which overrides Soniox's judgement about where a
   * sentence ends and, pushed eager, delivers captions three words at a time.
   */
  const client = () =>
    new SonioxRealtimeClient({
      apiKey: 'sk-test',
      model: 'stt-rt-v5',
      sampleRate: 16000,
      languageHints: ['gu', 'en'],
      languageHintsStrict: true,
      targetLanguage: 'en',
      maxEndpointDelayMs: 2000,
    });

  it('does not send endpoint_sensitivity unless asked to', () => {
    expect(client().buildConfigMessage()).not.toHaveProperty('endpoint_sensitivity');
  });

  it('sends it when the config names one, so the escape hatch still works', () => {
    const tuned = new SonioxRealtimeClient({
      apiKey: 'sk-test',
      model: 'stt-rt-v5',
      sampleRate: 16000,
      languageHints: ['gu'],
      targetLanguage: 'en',
      endpointSensitivity: -0.5,
    });
    expect(tuned.buildConfigMessage()['endpoint_sensitivity']).toBe(-0.5);
  });

  it('does not send diarization or language identification', () => {
    // The prototype sends neither. Diarization matters twice over: it also
    // makes buildSegments split a sentence wherever the speaker id flickers.
    const message = client().buildConfigMessage();
    expect(message).not.toHaveProperty('enable_speaker_diarization');
    expect(message).not.toHaveProperty('enable_language_identification');
  });

  it('restricts to the languages named, as the prototype does', () => {
    expect(client().buildConfigMessage()['language_hints_strict']).toBe(true);
  });

  it('still refuses provisional tokens — the one deliberate difference', () => {
    // The prototype leaves this unset and receives them for its console view.
    // We never render provisional text, so not receiving it is strictly safer
    // and cannot affect where sentences end.
    expect(client().buildConfigMessage()['include_nonfinal']).toBe(false);
  });
});

describe('one flush is one caption', () => {
  const token = (text: string, s: number, e: number, status: 'original' | 'translation') =>
    ({ text, start_ms: s, end_ms: e, is_final: true, speaker: '1', translation_status: status }) as SonioxToken;

  /**
   * The regression this closes: `buildSegments` is the async ingest's cue
   * splitter, and live it was returning several lines from one flush. All of
   * them were delivered in the same synchronous loop, the overlay hard-replaced
   * on each, and only the last was ever seen — eighteen seconds of a sermon
   * with three quarters of it never displayed.
   *
   * The working prototype posts the whole of an event's finalised text as one
   * caption and never splits. So does this now.
   */
  it('never returns more than one line, however long the run', () => {
    const builder = new LineBuilder({
      pauseMs: 4000,
      maxChars: 138,
      maxSegmentMs: 20_000,
      minDisplayMs: 1500,
      });

    const spoken: SonioxToken[] = [];
    const translated: SonioxToken[] = [];
    for (let i = 0; i < 12; i++) {
      spoken.push(token(` વાક્ય ${i}.`, i * 1500, i * 1500 + 1400, 'original'));
      translated.push(token(` This is sentence ${i} of a long unbroken passage.`, 0, 0, 'translation'));
    }

    const lines = builder.push([...spoken, ...translated, token('<end>', 18_000, 18_000, 'original')]);
    expect(lines).toHaveLength(1);
    // And it carries the whole run, start to finish — nothing dropped.
    expect(lines[0]!.audioStartMs).toBe(0);
    expect(lines[0]!.audioEndMs).toBe(17_900);
    expect(lines[0]!.translation).toContain('sentence 0');
    expect(lines[0]!.translation).toContain('sentence 11');
  });

  it('still pairs the Gujarati with its English', () => {
    const builder = new LineBuilder({ minDisplayMs: 0 });
    const lines = builder.push([
      token(' ભક્તિ એ માર્ગ છે.', 0, 2000, 'original'),
      token(' Devotion is the path.', 0, 0, 'translation'),
      token('<end>', 2000, 2000, 'original'),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.original).toContain('ભક્તિ');
    expect(lines[0]!.translation).toBe('Devotion is the path.');
  });
});

describe('the English screen never shows Gujarati', () => {
  const spoken = (text: string, s: number, e: number) =>
    ({ text, start_ms: s, end_ms: e, is_final: true, speaker: '1', translation_status: 'original' }) as SonioxToken;
  const english = (text: string) =>
    ({ text, start_ms: 0, end_ms: 0, is_final: true, speaker: '1', translation_status: 'translation' }) as SonioxToken;
  const endpoint = (at: number) =>
    ({ text: '<end>', start_ms: at, end_ms: at, is_final: true }) as SonioxToken;

  /**
   * From three recorded services. An endpoint arrived before Soniox had sent
   * the translation, `buildSegments` fell back to the original, and the raw
   * Gujarati went out as a caption — then the English arrived and went out as a
   * second one. "સિંહાસન ઉપર." at 28.5s, "On the singasan, it starts" at 33.9s:
   * the same words twice, in two languages.
   */
  it('holds an untranslated run at an endpoint rather than showing the source', () => {
    const builder = new LineBuilder({ minDisplayMs: 0, maxUntranslatedMs: 30_000 });

    const held = builder.push([spoken(' સિંહાસન ઉપર.', 28_560, 30_060), endpoint(30_060)]);
    expect(held).toEqual([]);

    // The translation lands a few seconds later; both leave together, once.
    const out = builder.push([english(' On the singasan, it starts, brothers.'), endpoint(35_400)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.translation).toBe('On the singasan, it starts, brothers.');
    expect(out[0]!.translation).not.toMatch(/[઀-૿]/);
    // The Gujarati is still carried, for the .srt and the Google Doc.
    expect(out[0]!.original).toContain('સિંહાસન');
  });

  it('still emits what IS translated, keeping only the unpaired tail', () => {
    const builder = new LineBuilder({ minDisplayMs: 0, maxUntranslatedMs: 30_000 });
    const out = builder.push([
      spoken(' ભક્તિ એ માર્ગ છે.', 0, 2000),
      english(' Devotion is the path.'),
      spoken(' આજે આપણે વાત કરીશું.', 2100, 4000),
      endpoint(4000),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.translation).toBe('Devotion is the path.');
    expect(out[0]!.translation).not.toMatch(/[઀-૿]/);
  });
});
