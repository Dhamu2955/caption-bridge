import type { SonioxToken } from '../src/soniox/types.js';
import type { Block, BuildOptions } from '../src/segments/types.js';

export const OPTIONS: BuildOptions = {
  pauseMs: 1200,
  maxChars: 120,
  maxSegmentMs: 7000,
  minDisplayMs: 1500,
};

/** A spoken token — carries timing, per §4. */
export function spoken(
  text: string,
  startMs: number,
  endMs: number,
  speaker?: string | number,
): SonioxToken {
  const token: SonioxToken = {
    text,
    start_ms: startMs,
    end_ms: endMs,
    translation_status: 'original',
    language: 'gu',
  };
  if (speaker !== undefined) token.speaker = speaker;
  return token;
}

/** A translated token — deliberately has NO timing. */
export function translated(text: string, speaker?: string | number): SonioxToken {
  const token: SonioxToken = {
    text,
    translation_status: 'translation',
    language: 'en',
    source_language: 'gu',
  };
  if (speaker !== undefined) token.speaker = speaker;
  return token;
}

export function block(partial: Partial<Block> & { startMs: number; endMs: number }): Block {
  const original = partial.original ?? 'text';
  return {
    original,
    translation: partial.translation ?? original,
    startMs: partial.startMs,
    endMs: partial.endMs,
    speaker: partial.speaker,
    translated: partial.translated ?? true,
    endsSentence: partial.endsSentence ?? false,
    continuesWord: partial.continuesWord ?? false,
    translationContinuesWord: partial.translationContinuesWord ?? false,
    spokenTokens: partial.spokenTokens ?? [spoken(original, partial.startMs, partial.endMs)],
  };
}
