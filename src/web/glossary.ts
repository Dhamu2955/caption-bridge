import { Router, type RequestHandler } from 'express';

import type { AppConfig, TranslationTerm } from '../config.js';
import type { ConfigStore } from '../settings/configStore.js';
import {
  BUILT_IN_CONTEXT_TERMS,
  BUILT_IN_GENERAL_CONTEXT,
  BUILT_IN_TRANSLATION_TERMS,
} from '../soniox/vocabulary.js';

/**
 * The vocabulary, as something you can look at and change.
 *
 * Editing it as two JSON blobs in a settings pane worked, in the sense that the
 * bytes ended up in the right place. But the list is 200 entries long, half of
 * it is built in and half is the mandir's, and the two are indistinguishable
 * once merged — so nobody could see what was already covered, and adding a term
 * that duplicated a built-in one was the natural mistake.
 *
 * So the API answers the questions actually being asked: what is in force, where
 * did it come from, and has something local replaced it.
 */

export type TermOrigin = 'built-in' | 'local' | 'override';

export interface GlossaryTerm extends TranslationTerm {
  origin: TermOrigin;
  /** For an override, the English it replaced — so the change is legible. */
  replaces?: string;
}

export interface GlossarySection {
  id: string;
  title: string;
  /** What this section does, in the terms of someone curating it. */
  blurb: string;
}

/**
 * Grouped by what the entries are for, not by where they came from.
 *
 * The order is the order they are wanted in: names get fixed every week, place
 * names when a new mandir is mentioned, and the register block almost never.
 */
export const GLOSSARY_SECTIONS: readonly GlossarySection[] = [
  {
    id: 'translation',
    title: 'How words come out in English',
    blurb:
      'The English a Gujarati phrase must become. Soniox treats these as a strong ' +
      'hint rather than a rule, so a term that keeps coming out wrong may also ' +
      'need a line in the corrections list.',
  },
  {
    id: 'recognition',
    title: 'Words to expect in the audio',
    blurb:
      'Names and terms the speaker uses, so they are heard correctly in the first ' +
      'place. These change what is transcribed, not how it is translated.',
  },
  {
    id: 'register',
    title: 'How the English should read',
    blurb:
      'What the audio is and how it should sound: a sermon rather than a podcast, ' +
      'and grace rather than a literal reading. Rarely worth changing, but it is ' +
      'what stops an awkward sentence reaching a screen in the hall.',
  },
];

function localTermMap(config: AppConfig): Map<string, string> {
  return new Map(config.soniox.translationTerms.map((term) => [term.source, term.target]));
}

/** Every term in force, said once, with where it came from. */
export function glossaryTerms(config: AppConfig): GlossaryTerm[] {
  const local = localTermMap(config);
  const terms: GlossaryTerm[] = [];
  const seen = new Set<string>();

  if (config.soniox.builtInGlossary) {
    for (const term of BUILT_IN_TRANSLATION_TERMS) {
      seen.add(term.source);
      const replacement = local.get(term.source);
      terms.push(
        replacement === undefined
          ? { ...term, origin: 'built-in' }
          : { source: term.source, target: replacement, origin: 'override', replaces: term.target },
      );
    }
  }

  for (const [source, target] of local) {
    if (seen.has(source)) continue;
    terms.push({ source, target, origin: 'local' });
  }

  return terms;
}

export interface GlossaryContextTerm {
  term: string;
  origin: Exclude<TermOrigin, 'override'>;
}

export function glossaryContextTerms(config: AppConfig): GlossaryContextTerm[] {
  const local = new Set(config.soniox.contextTerms);
  const out: GlossaryContextTerm[] = [];
  const seen = new Set<string>();

  if (config.soniox.builtInGlossary) {
    for (const term of BUILT_IN_CONTEXT_TERMS) {
      seen.add(term);
      out.push({ term, origin: 'built-in' });
    }
  }
  for (const term of local) {
    if (seen.has(term)) continue;
    out.push({ term, origin: 'local' });
  }
  return out;
}

export interface GlossaryRouterOptions {
  getConfig: () => AppConfig;
  store: ConfigStore;
  guard: RequestHandler;
}

/** Only the local half is writable — the built-in list is code, not data. */
interface GlossaryUpdate {
  translationTerms?: TranslationTerm[];
  contextTerms?: string[];
}

function parseUpdate(body: unknown): GlossaryUpdate | string {
  if (typeof body !== 'object' || body === null) return 'expected an object';
  const candidate = body as { translationTerms?: unknown; contextTerms?: unknown };
  const update: GlossaryUpdate = {};

  if (candidate.translationTerms !== undefined) {
    if (!Array.isArray(candidate.translationTerms)) return 'translationTerms must be an array';
    const terms: TranslationTerm[] = [];
    for (const entry of candidate.translationTerms) {
      if (
        typeof entry !== 'object' || entry === null ||
        typeof (entry as TranslationTerm).source !== 'string' ||
        typeof (entry as TranslationTerm).target !== 'string'
      ) {
        return 'each term needs a source and a target';
      }
      const source = (entry as TranslationTerm).source.trim();
      const target = (entry as TranslationTerm).target.trim();
      if (!source || !target) return 'a term cannot have an empty side';
      terms.push({ source, target });
    }
    update.translationTerms = terms;
  }

  if (candidate.contextTerms !== undefined) {
    if (
      !Array.isArray(candidate.contextTerms) ||
      candidate.contextTerms.some((term) => typeof term !== 'string')
    ) {
      return 'contextTerms must be an array of strings';
    }
    update.contextTerms = (candidate.contextTerms as string[])
      .map((term) => term.trim())
      .filter(Boolean);
  }

  return update;
}

export function createGlossaryRouter(options: GlossaryRouterOptions): Router {
  const router = Router();
  const { getConfig, store, guard } = options;

  router.get('/api/glossary', guard, (_req, res) => {
    const config = getConfig();
    res.json({
      sections: GLOSSARY_SECTIONS,
      builtInGlossary: config.soniox.builtInGlossary,
      terms: glossaryTerms(config),
      contextTerms: glossaryContextTerms(config),
      // Read-only: this is prose that took a long time to get right, and a
      // half-edited register instruction is worse than none.
      register: BUILT_IN_GENERAL_CONTEXT,
      counts: {
        builtIn: BUILT_IN_TRANSLATION_TERMS.length,
        local: config.soniox.translationTerms.length,
      },
    });
  });

  router.put('/api/glossary', guard, (req, res) => {
    void (async () => {
      const update = parseUpdate(req.body);
      if (typeof update === 'string') {
        res.status(400).json({ error: update });
        return;
      }

      const patch: Record<string, unknown> = {};
      if (update.translationTerms) patch['soniox.translationTerms'] = update.translationTerms;
      if (update.contextTerms) patch['soniox.contextTerms'] = update.contextTerms;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'nothing to change' });
        return;
      }

      // Same writer the settings pane uses: parsed before anything is written,
      // so an invalid value leaves config.json untouched.
      const result = await store.update(patch);
      if (!result.ok) {
        res.status(422).json({ error: result.error ?? 'could not be saved' });
        return;
      }
      res.json({
        ok: true,
        // A term added mid-service does nothing until the next start — Soniox
        // has no mid-session context API.
        appliesAtNextStart: true,
        mtimeMs: result.mtimeMs,
      });
    })();
  });

  return router;
}
