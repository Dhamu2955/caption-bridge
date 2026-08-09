/**
 * Shapes from the Soniox Speech-to-Text REST API (https://api.soniox.com/v1).
 * Verified against the API reference on 2026-07-29.
 */

/**
 * "original" / "none" → spoken token, CARRIES start_ms + end_ms.
 * "translation"       → translated token, NO timestamps.
 *
 * Translated tokens are emitted after the spoken tokens they came from and
 * follow the same sequence, but they are not 1-to-1 with them. See §4.
 */
export type TranslationStatus = 'none' | 'original' | 'translation';

export interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  speaker?: string | number;
  language?: string;
  /** Present on translated tokens only. */
  source_language?: string;
  translation_status?: TranslationStatus;
  /** Real-time only. INVARIANT 4: only `true` may ever be displayed. */
  is_final?: boolean;
}

export type TranscriptionStatus = 'queued' | 'processing' | 'completed' | 'error';

export interface UploadedFile {
  id: string;
  filename: string;
  size: number;
  created_at: string;
}

export interface OneWayTranslation {
  type: 'one_way';
  target_language: string;
}

export interface SonioxContext {
  terms?: string[];
  text?: string;
  translation_terms?: { source: string; target: string }[];
  /**
   * Instruction pairs describing the audio and the register the English should
   * be in. Not a glossary — this is where "a sermon, not a podcast" is said.
   */
  general?: { key: string; value: string }[];
}

export interface CreateTranscriptionRequest {
  model: string;
  file_id?: string;
  audio_url?: string;
  language_hints?: string[];
  language_hints_strict?: boolean;
  enable_speaker_diarization?: boolean;
  enable_language_identification?: boolean;
  translation?: OneWayTranslation;
  context?: SonioxContext;
  client_reference_id?: string;
}

export interface Transcription {
  id: string;
  status: TranscriptionStatus;
  created_at?: string;
  model?: string;
  filename?: string;
  audio_duration_ms?: number;
  error_type?: string;
  error_message?: string;
}

export interface Transcript {
  id: string;
  text?: string;
  tokens: SonioxToken[];
}
