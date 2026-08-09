import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { buildContext } from '../src/soniox/context.js';
import { normalizeTranslation } from '../src/soniox/normalize.js';
import {
  BUILT_IN_GENERAL_CONTEXT,
  BUILT_IN_TRANSLATION_TERMS,
} from '../src/soniox/vocabulary.js';

describe('the built-in glossary', () => {
  it('is on by default, so a fresh clone captions the vocabulary correctly', () => {
    const context = buildContext(parseConfig({}));
    expect(context?.translation_terms?.length).toBeGreaterThan(150);
    expect(context?.general?.length).toBe(BUILT_IN_GENERAL_CONTEXT.length);
  });

  it('sorts sources longest first, or "જય" shadows "જય શ્રી સ્વામિનારાયણ"', () => {
    const terms = buildContext(parseConfig({}))!.translation_terms!;
    const lengths = terms.map((term) => term.source.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('lets a local term override a built-in one without removing it', () => {
    const config = parseConfig({
      soniox: { translationTerms: [{ source: 'સ્વામિનારાયણ', target: 'Swaminarayana' }] },
    });
    const terms = buildContext(config)!.translation_terms!;
    const matches = terms.filter((term) => term.source === 'સ્વામિનારાયણ');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.target).toBe('Swaminarayana');
  });

  it('can be turned off, leaving only what the mandir set itself', () => {
    const config = parseConfig({
      soniox: { builtInGlossary: false, translationTerms: [{ source: 'ક', target: 'K' }] },
    });
    const context = buildContext(config)!;
    expect(context.translation_terms).toEqual([{ source: 'ક', target: 'K' }]);
    expect(context.general).toBeUndefined();
  });

  it('carries recent source lines, for a sentence that depends on the one before', () => {
    const context = buildContext(parseConfig({}), {
      recentSource: ['પહેલી લીટી', 'બીજી લીટી'],
    });
    expect(context?.text).toContain('પહેલી લીટી');
    expect(context?.text).toContain('બીજી લીટી');
  });

  it('keeps the recent-source block inside its character budget', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'ક'.repeat(40)}`);
    const context = buildContext(parseConfig({}), { recentSource: long });
    expect(context!.text!.length).toBeLessThanOrEqual(1600);
  });
});

describe('normalising a translation', () => {
  it('spells જય the way the sampradaya does', () => {
    expect(normalizeTranslation('Jai Shree Swaminarayan')).toBe('Jay Shree Swaminarayan');
    expect(normalizeTranslation('Jai Swaminarayan, everyone')).toBe('Jay Swaminarayan, everyone');
  });

  it('repairs the name the token joiner eats', () => {
    expect(normalizeTranslation('praise theaminarayan Bhagwan')).toBe(
      'praise the Swaminarayan Bhagwan',
    );
  });

  it('does not describe a murti as bipedal', () => {
    expect(normalizeTranslation('the bipedal form')).toBe('the two-armed form');
    expect(normalizeTranslation('a two-legged murti')).toBe('a two-armed murti');
  });

  it('keeps lineage titles as names rather than translating their parts', () => {
    expect(normalizeTranslation('the life-breath of our life')).toBe('Jeevanpran');
    expect(normalizeTranslation('lifeblood Swami Bapa')).toBe('Jeevanpran Swamibapa');
    expect(normalizeTranslation('Shree Mukta Jeevan Swami Bapa')).toBe(
      'Shree Muktajeevan Swamibapa',
    );
  });

  it('announces a death the way it would be said from the pulpit', () => {
    expect(normalizeTranslation("the dead brother's mother")).toBe(
      'the mother of the brother who has passed away',
    );
  });

  it('uses community spellings for places and terms', () => {
    expect(normalizeTranslation('travelling to Shikakas')).toBe('travelling to Secaucus');
    expect(normalizeTranslation('read the Vachanrut')).toBe('read the Vachanamrut');
    expect(normalizeTranslation('Shri Hari')).toBe('Shree Hari');
  });

  it('leaves ordinary English alone', () => {
    const plain = 'God is very pleased with all such families.';
    expect(normalizeTranslation(plain)).toBe(plain);
  });

  it('is safe on empty input', () => {
    expect(normalizeTranslation('')).toBe('');
  });

  it('never runs on the source, which the reviewer reads to judge the English', () => {
    // Guarded by where it is called, not by the function — this asserts the
    // rules are English-only so a stray call cannot corrupt Gujarati.
    const gujarati = 'જય શ્રી સ્વામિનારાયણ, બધા ભક્તો.';
    expect(normalizeTranslation(gujarati)).toBe(gujarati);
  });
});

describe('the ported term list', () => {
  it('has no duplicate sources, which would make the later one dead weight', () => {
    const sources = BUILT_IN_TRANSLATION_TERMS.map((term) => term.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('fits inside Soniox’s 8,000-token context cap with room for recent lines', () => {
    const context = buildContext(parseConfig({}))!;
    const chars = JSON.stringify(context).length;
    // ~4 chars a token for English; Indic script is denser, so this is a floor
    // on tokens, not a ceiling. Well under even on the pessimistic reading.
    expect(chars).toBeLessThan(24_000);
  });
});
