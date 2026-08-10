import type { SonioxToken } from '../soniox/types.js';
import type { Block, BuildOptions, Segment } from './types.js';
import { normalizeTranslation } from '../soniox/normalize.js';

/**
 * Tokens → segments. Shared with every later phase (§4).
 *
 * Five passes:
 *   1. separate + pair   spoken runs paired with the translation runs that follow
 *   2. split oversized   a block too long to be one cue is cut on token timing
 *   3. group             blocks → segments on punctuation / pause / speaker / size
 *   4. merge             INVARIANT 4 — nothing under minDisplayMs survives
 *   5. overlaps          consecutive cues never overlap
 *
 * Everything here is pure and deterministic: the same token array always
 * yields byte-identical output (§4 acceptance, idempotency).
 */

/** Sentence-final punctuation, Latin plus Devanagari danda. */
const SENTENCE_END = /[.!?।॥]["'’”)\]]*\s*$/;
const PUNCT_START = /^[,.!?;:।॥%)\]}…'"’”]/;
/** Real-time control tokens such as <end>. Not emitted by the async API, but
 *  the same parser feeds phase 5, where they are. */
const SPECIAL_TOKEN = /^<[a-z_]+>$/i;

export function isTranslationToken(token: SonioxToken): boolean {
  return token.translation_status === 'translation';
}

function isUsable(token: SonioxToken | undefined): token is SonioxToken {
  return (
    token != null &&
    typeof token.text === 'string' &&
    // A bare " " token is a word separator, not an empty token. Because the
    // tokens are sub-word pieces, discarding it fuses two words together.
    token.text !== '' &&
    !SPECIAL_TOKEN.test(token.text.trim())
  );
}

function speakerOf(token: SonioxToken): string | undefined {
  return token.speaker == null ? undefined : String(token.speaker);
}

/**
 * Split the stream by `translation_status`. Spoken tokens ("original"/"none")
 * carry timing; translated tokens do not, and are NOT 1-to-1 with them.
 */
export function separateTokens(tokens: SonioxToken[]): {
  spoken: SonioxToken[];
  translated: SonioxToken[];
} {
  const spoken: SonioxToken[] = [];
  const translated: SonioxToken[] = [];
  for (const token of tokens) {
    if (!isUsable(token)) continue;
    if (isTranslationToken(token)) translated.push(token);
    else spoken.push(token);
  }
  return { spoken, translated };
}

/**
 * Concatenate verbatim. Soniox tokens are SUB-WORD pieces and a leading space
 * is the only word delimiter: ["અ","ક્ષ","ર"] is the single word "અક્ષર", and
 * ["The"," l","ord"] is "The lord". Inserting a space between pieces that lack
 * one shatters every word, so never add separators here.
 */
export function joinTokens(tokens: SonioxToken[]): string {
  let out = '';
  for (const token of tokens) {
    if (token.text) out += token.text;
  }
  return normalize(out);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function joinText(a: string, b: string): string {
  if (!a) return normalize(b);
  if (!b) return normalize(a);
  return normalize(PUNCT_START.test(b) ? `${a}${b}` : `${a} ${b}`);
}

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text);
}

/**
 * Fill any gaps in spoken-token timing by carrying the previous token's end
 * forward. Translated tokens are left alone — they have no timing by design.
 */
export function fillSpokenTiming(tokens: SonioxToken[]): SonioxToken[] {
  let cursor = 0;
  return tokens.map((token) => {
    if (isTranslationToken(token)) return token;
    const start = Number.isFinite(token.start_ms) ? (token.start_ms as number) : cursor;
    const rawEnd = Number.isFinite(token.end_ms) ? (token.end_ms as number) : start;
    const end = Math.max(rawEnd, start);
    cursor = end;
    return { ...token, start_ms: start, end_ms: end };
  });
}

interface Run {
  kind: 'spoken' | 'translation';
  speaker: string | undefined;
  tokens: SonioxToken[];
}

function minStart(tokens: SonioxToken[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const t of tokens) {
    const v = t.start_ms;
    if (Number.isFinite(v) && (v as number) < min) min = v as number;
  }
  return Number.isFinite(min) ? min : 0;
}

function maxEnd(tokens: SonioxToken[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const t of tokens) {
    const v = Number.isFinite(t.end_ms) ? (t.end_ms as number) : t.start_ms;
    if (Number.isFinite(v) && (v as number) > max) max = v as number;
  }
  return Number.isFinite(max) ? max : 0;
}

/**
 * Pass 1. Group into maximal same-kind, same-speaker runs, then pair each
 * spoken run with the translation run that follows it.
 *
 * Run-to-run, never token-to-token — the two streams have different lengths
 * and their tokens do not correspond.
 */
export function buildBlocks(tokens: SonioxToken[]): Block[] {
  const usable = fillSpokenTiming(tokens.filter(isUsable));

  const runs: Run[] = [];
  for (const token of usable) {
    const kind = isTranslationToken(token) ? 'translation' : 'spoken';
    const speaker = speakerOf(token);
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && last.speaker === speaker) last.tokens.push(token);
    else runs.push({ kind, speaker, tokens: [token] });
  }

  const blocks: Block[] = [];
  // Translation with no spoken run before it cannot be timed on its own;
  // hold it and attach it to the next block. Should not happen — the API emits
  // translations after their source — but a dropped run must not lose text.
  let orphaned: SonioxToken[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run) continue;
    if (run.kind === 'translation') {
      orphaned.push(...run.tokens);
      continue;
    }
    const next = runs[i + 1];
    let translationTokens: SonioxToken[] = [];
    if (next && next.kind === 'translation' && next.speaker === run.speaker) {
      translationTokens = next.tokens;
      i++;
    }
    blocks.push(makeBlock(run, [...orphaned, ...translationTokens]));
    orphaned = [];
  }

  if (orphaned.length > 0) {
    const last = blocks[blocks.length - 1];
    if (last) {
      last.translation = joinText(last.translated ? last.translation : '', joinTokens(orphaned));
      last.translated = true;
      last.endsSentence = endsSentence(last.original) || endsSentence(last.translation);
    }
  }

  return blocks;
}

/** No leading space on the first piece means it continues the previous word. */
function startsMidWord(tokens: SonioxToken[]): boolean {
  const first = tokens[0]?.text;
  return typeof first === 'string' && first !== '' && !/^\s/.test(first);
}

function makeBlock(run: Run, translationTokens: SonioxToken[]): Block {
  const original = joinTokens(run.tokens);
  const translatedText = joinTokens(translationTokens);
  const translated = translatedText !== '';
  // No translation emitted — the speaker was already in the target language.
  const translation = translated ? translatedText : original;
  const startMs = minStart(run.tokens);
  const endMs = Math.max(maxEnd(run.tokens), startMs);
  const continuesWord = startsMidWord(run.tokens);
  return {
    original,
    translation,
    startMs,
    endMs,
    speaker: run.speaker,
    translated,
    endsSentence: endsSentence(original) || endsSentence(translation),
    continuesWord,
    translationContinuesWord: translated ? startsMidWord(translationTokens) : continuesWord,
    spokenTokens: run.tokens,
  };
}

/**
 * Pass 2. A single block can be huge — a long English passage produces one
 * unbroken spoken run, since nothing interleaves to break it up. Cut it on the
 * spoken tokens' own timing, which is exact.
 *
 * Only splits where both halves clear minDisplayMs, so this pass can never
 * manufacture a cue that INVARIANT 4 would then have to merge away.
 */
export function splitOversizedBlocks(blocks: Block[], options: BuildOptions): Block[] {
  const out: Block[] = [];
  const queue = [...blocks];
  let guard = 0;
  const limit = blocks.length * 64 + 1024;

  while (queue.length > 0 && guard++ < limit) {
    const block = queue.shift();
    if (!block) break;
    const tooLong = block.endMs - block.startMs > options.maxSegmentMs;
    const tooWide = block.translation.length > options.maxChars;
    if (!tooLong && !tooWide) {
      out.push(block);
      continue;
    }
    const halves = splitBlockOnce(block, options);
    if (!halves) {
      out.push(block);
      continue;
    }
    queue.unshift(...halves);
  }
  out.push(...queue);
  return out;
}

function splitBlockOnce(block: Block, options: BuildOptions): [Block, Block] | null {
  const tokens = block.spokenTokens;
  if (tokens.length < 2) return null;
  if (block.endMs - block.startMs < 2 * options.minDisplayMs) return null;

  const index = chooseSplitIndex(tokens, options.minDisplayMs);
  if (index === null) return null;

  const leftTokens = tokens.slice(0, index + 1);
  const rightTokens = tokens.slice(index + 1);
  if (leftTokens.length === 0 || rightTokens.length === 0) return null;

  const leftOriginal = joinTokens(leftTokens);
  const rightOriginal = joinTokens(rightTokens);

  let leftTranslation = leftOriginal;
  let rightTranslation = rightOriginal;
  let approximate = block.approximateSplit ?? false;

  if (block.translated) {
    const span = Math.max(1, block.endMs - block.startMs);
    const ratio = (maxEnd(leftTokens) - block.startMs) / span;
    const [left, right] = splitTextAt(block.translation, ratio);
    leftTranslation = left;
    rightTranslation = right;
    // The translation had to be cut at an estimated point rather than a real
    // token boundary. Surfaced in segments.json so it can be reviewed.
    approximate = true;
  }

  return [
    rebuild(block, leftTokens, leftOriginal, leftTranslation, approximate, true),
    rebuild(block, rightTokens, rightOriginal, rightTranslation, approximate, false),
  ];
}

function rebuild(
  source: Block,
  tokens: SonioxToken[],
  original: string,
  translation: string,
  approximate: boolean,
  isLeftHalf: boolean,
): Block {
  const startMs = minStart(tokens);
  // The left half keeps the source's relationship to whatever preceded it; the
  // right half's relationship is to the left half, read off its own first token.
  const continuesWord = isLeftHalf ? source.continuesWord : startsMidWord(tokens);
  const block: Block = {
    original,
    translation,
    startMs,
    endMs: Math.max(maxEnd(tokens), startMs),
    speaker: source.speaker,
    translated: source.translated,
    endsSentence: endsSentence(original) || endsSentence(translation),
    continuesWord,
    // Translated halves are cut at a space or sentence end, never mid-word.
    translationContinuesWord: isLeftHalf
      ? source.translationContinuesWord
      : source.translated
        ? false
        : continuesWord,
    spokenTokens: tokens,
  };
  if (approximate) block.approximateSplit = true;
  return block;
}

/** Prefer a sentence end, then the longest pause, then the midpoint. */
function chooseSplitIndex(tokens: SonioxToken[], minDisplayMs: number): number | null {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!first || !last) return null;
  const start = minStart(tokens);
  const end = maxEnd(tokens);
  const midpoint = start + (end - start) / 2;

  const anyIndex: number[] = [];
  const atWordBoundary: number[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (!left || !right) continue;
    const leftEnd = Number.isFinite(left.end_ms) ? (left.end_ms as number) : start;
    const rightStart = Number.isFinite(right.start_ms) ? (right.start_ms as number) : leftEnd;
    if (leftEnd - start < minDisplayMs) continue;
    if (end - rightStart < minDisplayMs) continue;
    anyIndex.push(i);
    // Tokens are sub-word pieces — only a leading space marks a real word
    // boundary. Cutting anywhere else splits a word across two cues.
    if (/^\s/.test(right.text ?? '')) atWordBoundary.push(i);
  }
  const viable = atWordBoundary.length > 0 ? atWordBoundary : anyIndex;
  if (viable.length === 0) return null;

  const nearestMidpoint = (candidates: number[]): number => {
    let best = candidates[0] as number;
    for (const i of candidates) {
      const a = Math.abs((tokens[i]?.end_ms ?? start) - midpoint);
      const b = Math.abs((tokens[best]?.end_ms ?? start) - midpoint);
      if (a < b) best = i;
    }
    return best;
  };

  const sentenceEnds = viable.filter((i) => endsSentence(tokens[i]?.text ?? ''));
  if (sentenceEnds.length > 0) return nearestMidpoint(sentenceEnds);

  let bestGap = 0;
  let bestIndex: number | null = null;
  for (const i of viable) {
    const gap = (tokens[i + 1]?.start_ms ?? 0) - (tokens[i]?.end_ms ?? 0);
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }
  if (bestIndex !== null) return bestIndex;

  return nearestMidpoint(viable);
}

/** Cut translated text near a proportional offset, preferring a real boundary. */
export function splitTextAt(text: string, ratio: number): [string, string] {
  const clamped = Math.min(0.9, Math.max(0.1, Number.isFinite(ratio) ? ratio : 0.5));
  const target = Math.round(text.length * clamped);

  const candidates: number[] = [];
  const sentence = /[.!?।॥]["'’”)\]]*\s/g;
  let match: RegExpExecArray | null;
  while ((match = sentence.exec(text)) !== null) candidates.push(match.index + match[0].length);
  if (candidates.length === 0) {
    for (let i = 0; i < text.length; i++) if (text[i] === ' ') candidates.push(i + 1);
  }

  let cut = target;
  if (candidates.length > 0) {
    let best = candidates[0] as number;
    for (const c of candidates) {
      if (Math.abs(c - target) < Math.abs(best - target)) best = c;
    }
    cut = best;
  }

  let left = text.slice(0, cut).trim();
  let right = text.slice(cut).trim();
  if (left === '' || right === '') {
    left = text.slice(0, target).trim();
    right = text.slice(target).trim();
  }
  return [left, right];
}

interface Draft {
  startMs: number;
  endMs: number;
  original: string;
  translation: string;
  speaker: string | undefined;
  approximateSplit: boolean;
  continuesWord: boolean;
}

/**
 * Pass 3. Blocks → segments.
 *
 * The async API has no endpoint detection (that is a real-time-only feature),
 * so §4's "break on endpoint detection" is served here by sentence-final
 * punctuation plus a pause threshold.
 */
export function groupBlocks(blocks: Block[], options: BuildOptions): Segment[] {
  const out: Segment[] = [];
  let draft: Draft | null = null;

  const flush = () => {
    if (draft) out.push(toSegment(draft, out.length));
    draft = null;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;

    if (draft) {
      const current: Draft = draft;
      // Hard break: a cue must never span two speakers.
      const speakerChanged = current.speaker !== block.speaker;
      const overflowsChars =
        current.translation.length + 1 + block.translation.length > options.maxChars;
      const overflowsTime = block.endMs - current.startMs > options.maxSegmentMs;
      if (speakerChanged || overflowsChars || overflowsTime) flush();
    }

    if (draft) append(draft, block);
    else draft = start(block);

    const next = blocks[i + 1];
    const gapToNext = next ? next.startMs - block.endMs : Number.POSITIVE_INFINITY;
    // Never end a cue in the middle of a word. A hyphenated compound can be
    // split across two blocks, and breaking there strands "-શ્રવણનો" at the
    // start of the next caption.
    const wouldSplitWord = next?.continuesWord === true;
    if (!next || ((block.endsSentence || gapToNext >= options.pauseMs) && !wouldSplitWord)) {
      flush();
    }
  }
  flush();

  return out;
}

function start(block: Block): Draft {
  return {
    startMs: block.startMs,
    endMs: block.endMs,
    original: block.original,
    translation: block.translation,
    speaker: block.speaker,
    approximateSplit: block.approximateSplit === true,
    continuesWord: block.continuesWord,
  };
}

function append(draft: Draft, block: Block): void {
  draft.endMs = Math.max(draft.endMs, block.endMs);
  // A block that continues a word must be concatenated, not space-joined.
  draft.original = block.continuesWord
    ? normalize(draft.original + block.original)
    : joinText(draft.original, block.original);
  draft.translation = block.translationContinuesWord
    ? normalize(draft.translation + block.translation)
    : joinText(draft.translation, block.translation);
  if (block.approximateSplit) draft.approximateSplit = true;
}

function toSegment(draft: Draft, index: number): Segment {
  const segment: Segment = {
    index,
    startMs: draft.startMs,
    endMs: Math.max(draft.endMs, draft.startMs),
    original: draft.original,
    translation: draft.translation,
    speaker: draft.speaker,
  };
  if (draft.approximateSplit) segment.approximateSplit = true;
  if (draft.continuesWord && index > 0) segment.continuesWord = true;
  return segment;
}

function mergeTwo(a: Segment, b: Segment): Segment {
  const glue = (left: string, right: string) =>
    b.continuesWord ? normalize(left + right) : joinText(left, right);
  const segment: Segment = {
    index: a.index,
    startMs: Math.min(a.startMs, b.startMs),
    endMs: Math.max(a.endMs, b.endMs),
    original: glue(a.original, b.original),
    translation: glue(a.translation, b.translation),
    // Merging across a speaker change loses the attribution rather than
    // asserting a wrong one. INVARIANT 4 outranks the speaker split.
    speaker: a.speaker === b.speaker ? a.speaker : undefined,
  };
  if (a.approximateSplit || b.approximateSplit) segment.approximateSplit = true;
  if (a.continuesWord) segment.continuesWord = true;
  return segment;
}

function reindex(segments: Segment[]): Segment[] {
  return segments.map((segment, index) => ({ ...segment, index }));
}

/**
 * Pass 4. INVARIANT 4 — no cue shorter than minDisplayMs.
 *
 * Merges FORWARD by preference: a short cue absorbed into the next one stays
 * on screen through the following speech, whereas merging backwards would
 * stretch a cue out into silence. Runs to a fixed point, since one merge can
 * still leave the result under the floor.
 *
 * A merge may push a cue past maxChars. That is intended: minDisplayMs is an
 * invariant, maxChars is "~120".
 */
export function mergeShortSegments(segments: Segment[], minDisplayMs: number): Segment[] {
  const out = segments.map((segment) => ({ ...segment }));
  let i = 0;
  while (i < out.length) {
    const segment = out[i];
    if (!segment) break;
    if (segment.endMs - segment.startMs >= minDisplayMs || out.length === 1) {
      i++;
      continue;
    }
    const next = out[i + 1];
    if (next) {
      out.splice(i, 2, mergeTwo(segment, next));
      continue; // re-check: the merged cue may still be short
    }
    const previous = out[i - 1];
    if (previous) {
      out.splice(i - 1, 2, mergeTwo(previous, segment));
      i = Math.max(0, i - 1);
      continue;
    }
    break;
  }
  return reindex(out);
}

/** Pass 5. Consecutive cues must not overlap; clamp, or merge if clamping
 *  would breach the minimum display time. */
export function resolveOverlaps(segments: Segment[], minDisplayMs: number): Segment[] {
  const list = segments.map((segment) => ({ ...segment }));
  const limit = list.length + 2;
  for (let guard = 0; guard < limit; guard++) {
    let changed = false;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (!a || !b || a.endMs <= b.startMs) continue;
      if (b.startMs - a.startMs >= minDisplayMs) a.endMs = b.startMs;
      else list.splice(i, 2, mergeTwo(a, b));
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return reindex(list);
}

/**
 * Last resort. Only reachable when a segment has nothing left to merge with —
 * in practice, a file that produced exactly one cue. This is the only place
 * timing is ever synthesised.
 */
export function enforceMinDuration(segments: Segment[], minDisplayMs: number): Segment[] {
  return segments.map((segment, i) => {
    if (segment.endMs - segment.startMs >= minDisplayMs) return segment;
    const next = segments[i + 1];
    const ceiling = next ? next.startMs : Number.POSITIVE_INFINITY;
    return { ...segment, endMs: Math.min(segment.startMs + minDisplayMs, ceiling) };
  });
}

export function buildSegments(tokens: SonioxToken[], options: BuildOptions): Segment[] {
  const blocks = splitOversizedBlocks(buildBlocks(tokens), options);
  let segments = groupBlocks(blocks, options);
  segments = mergeShortSegments(segments, options.minDisplayMs);
  segments = resolveOverlaps(segments, options.minDisplayMs);
  segments = mergeShortSegments(segments, options.minDisplayMs);
  segments = enforceMinDuration(segments, options.minDisplayMs);
  // Last, after every merge: gluing two segments can form a phrase neither of
  // them contained, and "Swami" + "Bapa" is exactly one of the rules.
  segments = segments.map((segment) => ({
    ...segment,
    translation: normalizeTranslation(segment.translation),
  }));
  return reindex(segments);
}
