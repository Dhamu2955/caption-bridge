import { describe, expect, it } from 'vitest';

import { normalizeTranslation } from '../src/soniox/normalize.js';

/**
 * The context block asks Soniox for British English and for these spellings in
 * as many words. A working prototype of this same job found the prompt is
 * treated as vocabulary bias rather than a style guide and the rules slip
 * through, so it fixes them in a second pass. These are that pass.
 */
describe('British spelling', () => {
  it('swaps the -ise and -yse families', () => {
    expect(normalizeTranslation('We recognize the organization')).toBe(
      'We recognise the organisation',
    );
    expect(normalizeTranslation('Analyze it and realize')).toBe('Analyse it and realise');
    expect(normalizeTranslation('internalizing')).toBe('internalising');
  });

  it('leaves the words that are -ize in British English too', () => {
    expect(normalizeTranslation('the size of the prize')).toBe('the size of the prize');
    expect(normalizeTranslation('seize it')).toBe('seize it');
    expect(normalizeTranslation('capsized')).toBe('capsized');
  });

  it('keeps capitalisation where it found it', () => {
    expect(normalizeTranslation('Realize this')).toBe('Realise this');
  });
});

describe('names the sampradaya spells its own way', () => {
  it('rejoins a split Swaminarayan', () => {
    expect(normalizeTranslation('Swami Narayan Bhagwan')).toBe('Swaminarayan Bhagwan');
  });

  it('uses -shree, not -shri', () => {
    expect(normalizeTranslation('Swamishri and Bapashri')).toBe('Swamishree and Bapashree');
    expect(normalizeTranslation('Shriji Maharaj')).toBe('Shreeji Maharaj');
  });

  it('writes the g- forms', () => {
    expect(normalizeTranslation('Jnan and Yajna')).toBe('Gnan and Yagna');
    expect(normalizeTranslation('Jnanmurti')).toBe('Gnan Murti');
    expect(normalizeTranslation('the Gaddi')).toBe('the Gadi');
  });

  it('never substitutes another tradition', () => {
    // The one replacement that would genuinely offend if it went out.
    expect(normalizeTranslation('Sai Bapa')).toBe('Swamibapa');
    expect(normalizeTranslation('Swaminarayan God')).toBe('Swaminarayan Bhagwan');
  });

  it('does not britishise a name it has just fixed', () => {
    expect(normalizeTranslation('Premmurti')).toBe('Prem Murti');
  });
});
