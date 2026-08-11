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

/**
 * Names the sampradaya spells its own way, from the American mandirs' bridge
 * and from a working prototype of this same job (soniox_en).
 *
 * Every one of these was in the prototype's fix table and not in ours, which
 * is as good a definition of "hit on air" as the rest of this file has.
 */
const SPELLING: readonly Rule[] = [
  // Split by the recogniser and rejoined wrong. Longest first.
  [/\bSwami\s+Narayan\b/gi, 'Swaminarayan'],
  [/\bSwamishri\b/g, 'Swamishree'],
  [/\bBapashri\b/g, 'Bapashree'],
  [/\bShriji\b/g, 'Shreeji'],
  [/\bPremmurti\b/gi, 'Prem Murti'],
  // Sanskrit j- where the community writes g-.
  [/\bJnanmurti\b/gi, 'Gnan Murti'],
  [/\bGnanmurti\b/gi, 'Gnan Murti'],
  [/\bJnan\b/gi, 'Gnan'],
  [/\bYajna\b/gi, 'Yagna'],
  [/\bGaddi\b/g, 'Gadi'],
  [/\bgaddi\b/g, 'gadi'],
  // A different tradition entirely, and the one substitution that would
  // genuinely offend. The prototype guards it; so should we.
  [/\bSai\s+Bapa\b/gi, 'Swamibapa'],
  [/\bSwaminarayan\s+God\b/gi, 'Swaminarayan Bhagwan'],
];

/**
 * British spelling, because asking for it does not work.
 *
 * The context block says "use British English" in as many words, and the
 * prototype's note is that Soniox treats the prompt as vocabulary bias rather
 * than a style guide — spelling rules slip through it. Measured there over a
 * real service, so this is a second pass rather than a prompt tweak.
 *
 * The suffix swap covers the -ise/-yse family. The handful of words that are
 * -ize in British English too are listed rather than trying to enumerate every
 * correct -ise word.
 */
const IZE_EXCEPTIONS = new Set([
  'size', 'sizes', 'sized', 'sizing',
  'capsize', 'capsizes', 'capsized', 'capsizing',
  'downsize', 'downsizes', 'downsized', 'downsizing',
  'resize', 'resizes', 'resized', 'resizing',
  'prize', 'prizes', 'prized', 'prizing',
  'seize', 'seizes', 'seized', 'seizing',
]);

const IZE_SUFFIX =
  /\b(\w+?)(ization|izations|izer|izers|izing|ized|izes|ize|yzing|yzed|yzes|yze)\b/gi;

function briticise(text: string): string {
  return text.replace(IZE_SUFFIX, (whole, stem: string, suffix: string) => {
    if (IZE_EXCEPTIONS.has(whole.toLowerCase())) return whole;
    return (
      stem +
      suffix.replace('iz', 'is').replace('IZ', 'IS').replace('yz', 'ys').replace('YZ', 'YS')
    );
  });
}

const ALL: readonly (readonly Rule[])[] = [
  JAY,
  TOKEN_GLUE,
  ICONOGRAPHY,
  LINEAGE,
  BEREAVEMENT,
  ROMANISATION,
  SPELLING,
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
  // Last: the name rules above may introduce words the suffix swap should see,
  // and it must never run on a proper noun it has just fixed.
  return briticise(out);
}
