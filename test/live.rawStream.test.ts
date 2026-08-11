import { describe, expect, it } from 'vitest';

import { RawTranslationStream } from '../src/live/pipeline/rawStream.js';
import { LineBuilder } from '../src/live/pipeline/lineBuilder.js';
import { BrowserAdapter } from '../src/live/adapters/browser.js';
import type { SonioxToken } from '../src/soniox/types.js';

const token = (
  text: string,
  status: SonioxToken['translation_status'],
  isFinal: boolean,
): SonioxToken => ({ text, translation_status: status, is_final: isFinal });

describe('continuous passthrough', () => {
  it('shows translated words the moment they arrive', () => {
    const stream = new RawTranslationStream();
    expect(stream.push([token('Devotion', 'translation', true)])).toBe('Devotion');
    expect(stream.push([token(' is the path', 'translation', true)])).toBe('Devotion is the path');
  });

  it('replaces the provisional tail rather than appending every revision', () => {
    // The core of it. A non-final run is Soniox's current guess at the same
    // stretch of speech; appending would print each guess one after another.
    const stream = new RawTranslationStream();
    stream.push([token('The Lord ', 'translation', true)]);

    expect(stream.push([token('is', 'translation', false)])).toBe('The Lord is');
    expect(stream.push([token('is merciful', 'translation', false)])).toBe('The Lord is merciful');
    // Verb-final Gujarati: the clause is re-ordered, not corrected.
    expect(stream.push([token('shows mercy to all', 'translation', false)])).toBe(
      'The Lord shows mercy to all',
    );
  });

  it('keeps a revised tail once it settles', () => {
    const stream = new RawTranslationStream();
    stream.push([token('He ', 'translation', true)]);
    stream.push([token('speaks', 'translation', false)]);
    // Same words come back final; the tail empties and they are kept.
    expect(stream.push([token('speaks today', 'translation', true)])).toBe('He speaks today');
    expect(stream.push([])).toBe('He speaks today');
  });

  it('carries English the speaker used, which is never translated', () => {
    // `none` means already in the target language — "please turn to page ten"
    // inside a Gujarati sentence. Dropping it would leave a hole exactly where
    // the speaker switched language.
    const stream = new RawTranslationStream();
    stream.push([token('He said ', 'translation', true)]);
    expect(stream.push([token('turn to page ten', 'none', true)])).toBe(
      'He said turn to page ten',
    );
  });

  it('never shows the Gujarati source', () => {
    const stream = new RawTranslationStream();
    stream.push([token('ભક્તિ', 'original', true), token('Devotion', 'translation', true)]);
    expect(stream.text).toBe('Devotion');
  });

  it('scrolls on a word boundary rather than growing for ninety minutes', () => {
    const stream = new RawTranslationStream({ windowChars: 40 });
    for (let i = 0; i < 40; i++) stream.push([token(`word${i} `, 'translation', true)]);

    expect(stream.text.length).toBeLessThanOrEqual(48);
    expect(stream.text).toContain('word39');
    // Cut between words, never mid-word.
    expect(stream.text.startsWith('word')).toBe(true);
  });

  it('starts empty again on reset', () => {
    const stream = new RawTranslationStream();
    stream.push([token('Something', 'translation', true)]);
    stream.reset();
    expect(stream.text).toBe('');
  });
});

describe('the passthrough cannot reach a pop-on output', () => {
  it('the line builder still discards every non-final token', () => {
    // INVARIANT 4 rule 1. Turning the raw feed on asks Soniox for non-final
    // tokens, and this is what stops them reaching venue, stream or YouTube:
    // the builder drops them whatever the config says.
    const builder = new LineBuilder({ maxBufferMs: 1000, minDisplayMs: 0 });
    const lines = builder.push([
      token('provisional', 'translation', false),
      token('also provisional', 'original', false),
    ]);
    expect(lines).toEqual([]);
    expect(builder.flush()).toEqual([]);
  });

  it('sends raw text as its own message, not as a caption', () => {
    // A `show` would let it reach code that assumes lines are immutable.
    const sent: unknown[] = [];
    const adapter = new BrowserAdapter('raw');
    adapter.attach({ send: (d) => sent.push(JSON.parse(d)), get open() { return true; } });

    adapter.raw('words so far');
    expect(sent).toEqual([{ type: 'raw', text: 'words so far' }]);
  });

  it('replays the latest text to a projector that reconnects mid-service', () => {
    const adapter = new BrowserAdapter('raw');
    adapter.raw('already on screen');

    const sent: unknown[] = [];
    adapter.attach({ send: (d) => sent.push(JSON.parse(d)), get open() { return true; } });
    expect(sent).toEqual([{ type: 'raw', text: 'already on screen' }]);
  });

  it('blanks on clear, so a dropped session leaves nothing frozen on air', () => {
    const sent: unknown[] = [];
    const adapter = new BrowserAdapter('raw');
    adapter.raw('mid sentence');
    adapter.attach({ send: (d) => sent.push(JSON.parse(d)), get open() { return true; } });
    adapter.clear();

    const late: unknown[] = [];
    adapter.attach({ send: (d) => late.push(JSON.parse(d)), get open() { return true; } });
    expect(late).toEqual([]);
  });
});

describe('cross-tagged proper nouns', () => {
  it('prints a name once when Soniox tags it both ways', () => {
    // "Shree Hari" needs no translation, so Soniox can emit it as
    // already-English AND as its own translation. Both arrive; both used to
    // print, and the caption read "Shree Hari Shree Hari".
    const stream = new RawTranslationStream();
    stream.push([
      token('Shree Hari', 'none', true),
      token('Shree Hari', 'translation', true),
    ]);
    expect(stream.text).toBe('Shree Hari');
  });

  it('keeps a genuine repeat inside one status', () => {
    // The digits of a number, or a speaker repeating themselves for emphasis.
    // Collapsing on text alone would eat these.
    const stream = new RawTranslationStream();
    stream.push([
      token('very', 'translation', true),
      token(' very', 'translation', true),
    ]);
    expect(stream.text).toBe('very very');
  });
});
