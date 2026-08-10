/*
  Fixing what the glossary asks for and does not get.

  `translation_terms` is a soft bias, not a rule — Soniox paraphrases through it
  often enough that the American mandirs' bridge grew a second pass to catch
  what slips, and every rule below is one they hit on air. Ported from their
  `service/translation-normalize.js`.

  Two things to keep straight when adding to this:

    - It runs on the ENGLISH translation only. Never on the Gujarati: the source
      is what the reviewer reads to judge the English, so it has to stay exactly
      what was said.
    - It is find-and-replace, not judgement. Only put a rule here when the wrong
      output is unambiguous — "Jai" is always meant to be "Jay"; a sentence that
      merely reads awkwardly is a job for the context block, not for a regex.
*/

type Rule = readonly [RegExp, string];

/** Soniox romanises જય as "Jai". The sampradaya spells it Jay. */
const JAY: readonly Rule[] = [
  [/\bJai\s+Shree\s+Swaminarayan\b/gi, 'Jay Shree Swaminarayan'],
  [/\bJai\s+Swaminarayan\b/gi, 'Jay Swaminarayan'],
  [/\bJai\s+Shree\s+Krishna\b/gi, 'Jay Shree Krishna'],
  [/\bJai\s+Shree\b/gi, 'Jay Shree'],
  [/\bJai\b/g, 'Jay'],
];

/**
 * Joining a partial to a final sometimes eats the "Sw" of Swaminarayan. A
 * band-aid, and knowingly so — but it is the highest-frequency name there is.
 */
const TOKEN_GLUE: readonly Rule[] = [
  [/\btheaminarayan\b/gi, 'the Swaminarayan'],
  [/\baminarayan\b/gi, 'Swaminarayan'],
];

/** દ્વિભુજ is a two-armed divine form. "Bipedal" is a literal reading of it. */
const ICONOGRAPHY: readonly Rule[] = [
  [/\bbi[\s‐-―-]*pedal\b/gi, 'two-armed'],
  [/\btwo[\s‐-―-]*legged\b/gi, 'two-armed'],
];

/**
 * Lineage titles are proper names. Translating their parts turns Jeevanpran
 * Swamibapa into "the life-breath of our life", which is both wrong and, on a
 * screen in front of the congregation, embarrassing. Longest phrase first.
 */
const LINEAGE: readonly Rule[] = [
  [/\bShree\s+Mukta\s*Jeevan\s+Swami\s+Bapa\b/gi, 'Shree Muktajeevan Swamibapa'],
  [/\bShree\s+Muktajeevan\s+Swami\s+Bapa\b/gi, 'Shree Muktajeevan Swamibapa'],
  [/\bMukta\s*Jeevan\s+Swami\s+Bapa\b/gi, 'Muktajeevan Swamibapa'],
  [/\bMuktajeevan\s+Swami\s+Bapa\b/gi, 'Muktajeevan Swamibapa'],
  [/\bJeevanpran\s+Swami\s+Bapa\b/gi, 'Jeevanpran Swamibapa'],
  [/\bJivanpran\s+Swami\s+Bapa\b/gi, 'Jeevanpran Swamibapa'],
  [/\bJivanpran\s+Swamibapa\b/gi, 'Jeevanpran Swamibapa'],
  [
    /\b(?:the\s+)?life[\s‐-―-]*breath(?:\s+of\s+(?:our|the)\s+life)?\b/gi,
    'Jeevanpran',
  ],
  [/\b(?:the\s+)?life\s+and\s+breath\s+of\s+life\b/gi, 'Jeevanpran'],
  [/\blifeblood\b/gi, 'Jeevanpran'],
  [/\bJivanpran\b/gi, 'Jeevanpran'],
  [/\bMukta\s+Jeevan\b/gi, 'Muktajeevan'],
  [/\bSwami\s+Bapa\b/g, 'Swamibapa'],
];

/** A death is announced from the pulpit. "Dead brother's mother" is not how. */
const BEREAVEMENT: readonly Rule[] = [
  [/\bdead\s+brother['’]s\s+mother\b/gi, 'mother of the brother who has passed away'],
  [
    /\bmother\s+of\s+the\s+(?:dead|deceased)\s+brother\b/gi,
    'mother of the brother who has passed away',
  ],
];

/**
 * Spellings the community uses, against what a transcriber guesses at. Place
 * names are the worst of it — Secaucus comes back four different ways.
 */
const ROMANISATION: readonly Rule[] = [
  [/\bNad\s+dynasty\b/gi, 'Nad Vanshi'],
  [/\bNad\s*Vanshiya\b/gi, 'Nad Vanshi'],
  [/\bNadvanshiya\b/gi, 'Nad Vanshi'],
  [/\byajman\b/gi, 'sponsor'],
  [/\bGovada\b/gi, 'Gavada'],
  [/\bMukhasan\b/gi, 'Mokhasan'],
  [/\bMokasan\b/gi, 'Mokhasan'],
  [/\bMokhasun\b/gi, 'Mokhasan'],
  [/\bMukhassan\b/gi, 'Mokhasan'],
  [/\bShicago\b/gi, 'Chicago'],
  [/\bShikakas\b/gi, 'Secaucus'],
  [/\bShikhakas\b/gi, 'Secaucus'],
  [/\bSikakas\b/gi, 'Secaucus'],
  [/\bSekaucus\b/gi, 'Secaucus'],
  [/\bmorning[\s‐-―-]*birth\b/gi, 'Pratah Smaraniya'],
  [/\bPratahsmarniya\b/gi, 'Pratah Smaraniya'],
  [/\bPratah\s+Smaraniya\b/gi, 'Pratah Smaraniya'],
  [/\bSamayons\b/g, 'Samayo'],
  [/\bSamayon\b/g, 'Samayo'],
  [/\bRas\b/g, 'Raas'],
  [/\bras\b/g, 'raas'],
  [/\bShri\b/g, 'Shree'],
  [/\bVachanrut\b/gi, 'Vachanamrut'],
  [/\bVachnamrut\b/gi, 'Vachanamrut'],
  // The community writes વૃ/કૃ with a "u": Harikrushna, krupa, vrutti.
  [/\bVrittis\b/g, 'Vruttis'],
  [/\bvrittis\b/g, 'vruttis'],
  [/\bVritti\b/g, 'Vrutti'],
  [/\bvritti\b/g, 'vrutti'],
];

const ALL: readonly (readonly Rule[])[] = [
  JAY,
  TOKEN_GLUE,
  ICONOGRAPHY,
  LINEAGE,
  BEREAVEMENT,
  ROMANISATION,
];

/**
 * Apply every rule, in order. Order matters within a group — the longest phrase
 * has to win before a shorter rule inside it fires.
 */
export function normalizeTranslation(text: string): string {
  if (!text) return text;
  let out = text;
  for (const group of ALL) {
    for (const [pattern, replacement] of group) out = out.replace(pattern, replacement);
  }
  return out;
}
