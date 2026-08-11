import { describe, expect, it } from 'vitest';

import { LATENCY_PRESETS, presetById } from '../src/live/presets.js';
import { SETTINGS } from '../src/settings/schema.js';
import { parseConfig } from '../src/config.js';
import { outputConfigs } from '../src/live/outputs.js';
import { LineBuilder } from '../src/live/pipeline/lineBuilder.js';
import type { SonioxToken } from '../src/soniox/types.js';

/** Rebuild a config the way the settings writer would, from a preset's patch. */
function configFrom(values: Record<string, number | boolean>) {
  const raw: Record<string, Record<string, unknown>> = {};
  for (const [path, value] of Object.entries(values)) {
    const [head, tail] = path.split('.') as [string, string];
    (raw[head] ??= {})[tail] = value;
  }
  return parseConfig(raw);
}

describe('latency presets', () => {
  it('names only settings that exist', () => {
    // A typo here would write a key the config parser ignores, and the preset
    // would appear to work while changing nothing.
    const known = new Set(SETTINGS.map((setting) => setting.path));
    for (const preset of LATENCY_PRESETS) {
      for (const path of Object.keys(preset.values)) {
        expect(known, `${preset.id} → ${path}`).toContain(path);
      }
    }
  });

  it('carries values the config writer will accept', () => {
    // The writer validates types and ranges and rejects the whole patch on one
    // bad value, so a preset that cannot be saved is worse than none.
    for (const preset of LATENCY_PRESETS) {
      expect(() => configFrom(preset.values), preset.id).not.toThrow();
    }
  });

  it('matches each value to its declared type', () => {
    const types = new Map(SETTINGS.map((setting) => [setting.path, setting.type]));
    for (const preset of LATENCY_PRESETS) {
      for (const [path, value] of Object.entries(preset.values)) {
        const expected = types.get(path) === 'boolean' ? 'boolean' : 'number';
        expect(typeof value, `${preset.id} → ${path}`).toBe(expected);
      }
    }
  });

  it('changes the same settings in every preset', () => {
    // Otherwise switching from one to another leaves a value behind from the
    // last, and the result is neither preset.
    const shape = Object.keys(LATENCY_PRESETS[0]!.values).sort();
    for (const preset of LATENCY_PRESETS) {
      expect(Object.keys(preset.values).sort(), preset.id).toEqual(shape);
    }
  });

  it('turns skipping off wherever the assembly delay is short', () => {
    // The trap the presets exist to close: a short delay schedules most lines
    // into the past, and skipping then discards them. Fast plus skipping is a
    // blank screen, and the two settings sit in different sections of the form.
    for (const preset of LATENCY_PRESETS) {
      const config = configFrom(preset.values);
      if (config.live.delayAssemblyMs < 5000) {
        expect(config.live.skipLateLines, `${preset.id} would show nothing`).toBe(false);
      }
    }
  });

  it('reaches every output, since the delay is per output', () => {
    const fast = configFrom(presetById('fast')!.values);
    const outputs = outputConfigs(fast);
    expect(outputs.venue.delayMs).toBe(2000);
    expect(outputs.venue.skipLate).toBe(false);
    // The reviewed path still adds the review window on top; fast is about
    // assembly, and a reviewer window is a separate decision.
    expect(outputs.stream.delayMs).toBe(2000 + fast.live.delayReviewMs);
  });

  it('is actually faster than the accurate one', () => {
    const accurate = configFrom(presetById('accurate')!.values);
    const fast = configFrom(presetById('fast')!.values);
    expect(fast.live.delayAssemblyMs).toBeLessThan(accurate.live.delayAssemblyMs);
    expect(fast.live.maxBufferMs).toBeLessThan(accurate.live.maxBufferMs);
    // Higher is eager: Soniox calls a clause finished sooner.
    expect(fast.live.endpointSensitivity).toBeGreaterThan(accurate.live.endpointSensitivity);
    expect(fast.live.maxEndpointDelayMs).toBeLessThan(accurate.live.maxEndpointDelayMs);
  });

  it('says what it costs, because the cost is not visible until a service', () => {
    for (const preset of LATENCY_PRESETS) {
      expect(preset.cost.length, preset.id).toBeGreaterThan(20);
      expect(preset.blurb.length, preset.id).toBeGreaterThan(20);
    }
  });
});

describe('what actually bounds a chunk', () => {
  const spoken = (text: string, s: number, e: number) =>
    ({ text, start_ms: s, end_ms: e, is_final: true, translation_status: 'original', speaker: '1' }) as SonioxToken;
  const translated = (text: string) =>
    ({ text, is_final: true, translation_status: 'translation', speaker: '1' }) as SonioxToken;

  /** Twelve seconds of speech in 500ms batches, translated every `every` ms. */
  function chunks(maxBufferMs: number, minDisplayMs: number, every: number) {
    const builder = new LineBuilder({
      maxBufferMs,
      minDisplayMs,
      pauseMs: 4000,
      maxChars: 138,
      maxSegmentMs: 20_000,
    });
    const spans: number[] = [];
    for (let t = 0; t < 12_000; t += 500) {
      const batch = [spoken(` w${t}`, t, t + 500)];
      if (t > 0 && t % every === 0) batch.push(translated(` english-${t}`));
      for (const line of builder.push(batch)) spans.push(line.audioEndMs - line.audioStartMs);
    }
    return spans;
  }

  it('cannot cut smaller than Soniox translates, whatever the buffer says', () => {
    // The finding behind the chunks preset. `flushTranslated` holds speech
    // until its translation has arrived, so shrinking our own buffer against
    // slow translation runs changes nothing about the size of a chunk — which
    // is why lowering maxBufferMs on its own looks like it did not work.
    const slow = chunks(2000, 800, 4000);
    expect(Math.min(...slow)).toBeGreaterThan(3000);
  });

  it('produces short chunks once Soniox is finalising often', () => {
    // Which is what maxEndpointDelayMs buys, and why the preset moves it.
    const brisk = chunks(2000, 800, 1000);
    expect(brisk.length).toBeGreaterThan(4);
    expect(Math.max(...brisk)).toBeLessThanOrEqual(2500);
  });

  it('moves both levers together, so the buffer is not lowered on its own', () => {
    const accurate = presetById('accurate')!.values;
    const chunked = presetById('chunks')!.values;
    expect(chunked['live.maxBufferMs']).toBeLessThan(accurate['live.maxBufferMs'] as number);
    expect(chunked['live.maxEndpointDelayMs']).toBeLessThan(
      accurate['live.maxEndpointDelayMs'] as number,
    );
    // And the merge floor, or short chunks are glued back together.
    expect(chunked['live.minDisplayMs']).toBeLessThan(accurate['live.minDisplayMs'] as number);
  });
});
