import type { SonioxToken } from '../../soniox/types.js';

/**
 * Translation tokens straight to a screen, as they arrive.
 *
 * This is the passthrough path: no line building, no queue, no delay, no
 * review. Soniox streams translation "chunk by chunk, without waiting for the
 * full sentence", and this renders exactly that.
 *
 * IT REWRITES ITSELF, AND THAT IS NOT A BUG HERE. Non-final tokens are
 * provisional by definition: the tail of the sentence is replaced wholesale
 * every time Soniox revises it, and because Gujarati is verb-final the revision
 * is often a re-ordering of the clause rather than a corrected word. SPEC.md
 * INVARIANT 4 exists because a mandir shipped this and found it worse than no
 * captions — so this output is deliberately separate from `venue`, `stream` and
 * the YouTube path, all of which stay pop-on. It is opt-in, it is its own
 * overlay, and nothing else changes behaviour when it is switched on.
 *
 * Two things it is NOT suitable for, both structural rather than tunable:
 *
 *   - YouTube closed captions. Translated tokens carry no timestamps, so there
 *     is nothing to anchor a caption to on the stream's timeline.
 *   - The reviewer. There are no lines to hold, correct or drop — text is on
 *     screen before anybody could read it.
 */

export interface RawStreamOptions {
  /**
   * Characters kept on screen. A projector fits about this much at caption
   * size, and an unbounded string would grow for ninety minutes.
   */
  windowChars?: number;
}

const DEFAULT_WINDOW = 240;

export class RawTranslationStream {
  private readonly windowChars: number;
  /** Text Soniox has committed to. Never revised. */
  private settled = '';
  /** The provisional tail, replaced in full on every message. */
  private tail = '';
  /** For the cross-tagging guard in `push`. */
  private lastText: string | undefined;
  private lastStatus: SonioxToken['translation_status'];

  constructor(options: RawStreamOptions = {}) {
    this.windowChars = options.windowChars ?? DEFAULT_WINDOW;
  }

  /**
   * Feed one batch from the socket; returns the text to display now.
   *
   * Only English is taken. `translation` is translated text, and `none` is text
   * that needed no translation — the speaker saying "please turn to page ten"
   * inside a Gujarati sentence comes back as `none`, and dropping it would put
   * a hole in the stream exactly where the speaker switched language. Tokens
   * marked `original` are the Gujarati source and never appear here.
   */
  push(tokens: SonioxToken[]): string {
    let tail = '';

    for (const token of tokens) {
      const status = token.translation_status;
      if (status !== 'translation' && status !== 'none') continue;
      if (typeof token.text !== 'string') continue;

      // Soniox sometimes tags a proper noun both ways: once as already-English
      // and once as its own translation, because "Shree Hari" needs none. Both
      // arrive and both would be printed. Only a repeat whose status CHANGED is
      // dropped — genuinely repeated text inside one status (the "000" of a
      // number, a stammer) must survive.
      if (token.text === this.lastText && status !== this.lastStatus) continue;
      this.lastText = token.text;
      this.lastStatus = status;

      if (token.is_final === true) this.settled += token.text;
      else tail += token.text;
    }

    // Wholesale replacement, not append: a non-final run is Soniox's current
    // best guess at the same stretch of speech, so appending would print every
    // revision one after another instead of replacing the last.
    this.tail = tail;

    this.trim();
    return this.text;
  }

  /** Everything settled, plus whatever is currently provisional. */
  get text(): string {
    return `${this.settled}${this.tail}`.replace(/\s+/g, ' ').trimStart();
  }

  /** Drop settled text that has scrolled off, on a word boundary. */
  private trim(): void {
    const overflow = this.settled.length + this.tail.length - this.windowChars;
    if (overflow <= 0) return;

    const cut = this.settled.indexOf(' ', overflow);
    this.settled = cut === -1 ? '' : this.settled.slice(cut + 1);
  }

  /** Between services, and whenever capture restarts. */
  reset(): void {
    this.settled = '';
    this.tail = '';
    this.lastText = undefined;
    this.lastStatus = undefined;
  }
}
