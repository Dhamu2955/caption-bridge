import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { glossaryContextTerms, glossaryTerms } from '../src/web/glossary.js';
import { BUILT_IN_TRANSLATION_TERMS } from '../src/soniox/vocabulary.js';

/**
 * The tab's whole job is answering "what is in force and where did it come
 * from", because a merged list of two hundred entries answers neither.
 */
describe('what the glossary tab is shown', () => {
  it('lists every built-in term once, marked as built in', () => {
    const terms = glossaryTerms(parseConfig({}));
    expect(terms).toHaveLength(BUILT_IN_TRANSLATION_TERMS.length);
    expect(terms.every((term) => term.origin === 'built-in')).toBe(true);
  });

  it('shows a local term as ours', () => {
    // A phrase the built-in list does not have — picking one it did was how I
    // learned the ported glossary already covers મંદિર.
    const config = parseConfig({
      soniox: { translationTerms: [{ source: 'ઉદાહરણ શબ્દ', target: 'example word' }] },
    });
    const added = glossaryTerms(config).filter((term) => term.origin === 'local');
    expect(added).toEqual([
      { source: 'ઉદાહરણ શબ્દ', target: 'example word', origin: 'local' },
    ]);
  });

  it('shows a replaced built-in once, as an override, saying what it replaced', () => {
    const builtIn = BUILT_IN_TRANSLATION_TERMS[0]!;
    const config = parseConfig({
      soniox: { translationTerms: [{ source: builtIn.source, target: 'Something else' }] },
    });
    const terms = glossaryTerms(config);
    const matches = terms.filter((term) => term.source === builtIn.source);

    // Once, not twice — the failure this guards is the same phrase appearing
    // in both lists with no way to tell which one wins.
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      source: builtIn.source,
      target: 'Something else',
      origin: 'override',
      replaces: builtIn.target,
    });
  });

  it('shows only local terms when the built-in glossary is off', () => {
    const config = parseConfig({
      soniox: { builtInGlossary: false, translationTerms: [{ source: 'ક', target: 'K' }] },
    });
    expect(glossaryTerms(config)).toEqual([{ source: 'ક', target: 'K', origin: 'local' }]);
  });

  it('does the same for words to expect in the audio', () => {
    const config = parseConfig({ soniox: { contextTerms: ['Maninagar'] } });
    const terms = glossaryContextTerms(config);
    expect(terms.filter((term) => term.origin === 'local')).toEqual([
      { term: 'Maninagar', origin: 'local' },
    ]);
    expect(terms.filter((term) => term.origin === 'built-in').length).toBeGreaterThan(50);
  });

  it('does not list a word twice when the mandir adds one that is already built in', () => {
    const config = parseConfig({ soniox: { contextTerms: ['સ્વામિનારાયણ'] } });
    const terms = glossaryContextTerms(config).map((term) => term.term);
    expect(new Set(terms).size).toBe(terms.length);
  });
});
