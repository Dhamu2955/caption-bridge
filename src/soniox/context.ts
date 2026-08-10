import type { AppConfig } from '../config.js';
import type { SonioxContext } from './types.js';
import {
  BUILT_IN_CONTEXT_TERMS,
  BUILT_IN_GENERAL_CONTEXT,
  BUILT_IN_TRANSLATION_TERMS,
  type TranslationTerm,
} from './vocabulary.js';

/**
 * One context object for both paths.
 *
 * Live and async were sending different things: `ingest` passed the glossary,
 * the realtime start frame had no `context` key at all, so a term added for the
 * weekly export did nothing on air. Anything worth telling Soniox about the
 * vocabulary is worth telling it in both places, so there is one builder.
 */

/**
 * Local terms win. A mandir that spells a name differently from the built-in
 * list should not have to remove the entry it disagrees with — adding its own
 * is enough.
 */
function mergeTerms(
  builtIn: readonly TranslationTerm[],
  local: readonly TranslationTerm[],
): TranslationTerm[] {
  const bySource = new Map<string, TranslationTerm>();
  for (const term of builtIn) bySource.set(term.source, term);
  for (const term of local) bySource.set(term.source, term);
  return [...bySource.values()];
}

/**
 * Longest source first. Soniox matches greedily, so with "જય" ahead of
 * "જય શ્રી સ્વામિનારાયણ" the short one wins and the full phrase never matches.
 */
function longestFirst(terms: TranslationTerm[]): TranslationTerm[] {
  return [...terms].sort((a, b) => b.source.length - a.source.length);
}

export interface ContextOptions {
  /**
   * Recent source lines, for translating a sentence that depends on the one
   * before it. Only meaningful at connect — Soniox has no mid-session context
   * API, so this is read once per connection.
   */
  recentSource?: readonly string[];
}

/** Roughly 4 chars a token for English; Indic script is denser and weighs more. */
const MAX_RECENT_CHARS = 1600;
const RECENT_PREAMBLE =
  'Preceding source lines, oldest first. The speaker leaves sentences ' +
  'unfinished and carries subjects across them; use these to resolve ' +
  'referents so the English reads as continuous speech.';

function recentText(lines: readonly string[]): string {
  const body = lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (body.length === 0) return '';
  const joined = `${RECENT_PREAMBLE}\n\n${body.join('\n')}`;
  return joined.length <= MAX_RECENT_CHARS ? joined : joined.slice(-MAX_RECENT_CHARS);
}

/** Undefined when there is nothing to say, so the key is omitted rather than empty. */
export function buildContext(
  config: AppConfig,
  options: ContextOptions = {},
): SonioxContext | undefined {
  const useBuiltIn = config.soniox.builtInGlossary;

  const terms = useBuiltIn
    ? [...new Set([...BUILT_IN_CONTEXT_TERMS, ...config.soniox.contextTerms])]
    : [...config.soniox.contextTerms];

  const translationTerms = longestFirst(
    useBuiltIn
      ? mergeTerms(BUILT_IN_TRANSLATION_TERMS, config.soniox.translationTerms)
      : mergeTerms([], config.soniox.translationTerms),
  );

  const general = useBuiltIn ? [...BUILT_IN_GENERAL_CONTEXT] : [];
  const text = recentText(options.recentSource ?? []);

  const context: SonioxContext = {
    ...(general.length > 0 ? { general } : {}),
    ...(terms.length > 0 ? { terms } : {}),
    ...(translationTerms.length > 0 ? { translation_terms: translationTerms } : {}),
    ...(text ? { text } : {}),
  };

  return Object.keys(context).length > 0 ? context : undefined;
}
