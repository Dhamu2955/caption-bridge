import type { CaptionLine, OutputAdapter } from '../types.js';

/**
 * Development adapter. §10: develop against this, it logs every call with a
 * timestamp. Also the assertion surface for the replay tests.
 */

export interface StubCall {
  at: number;
  action: 'show' | 'clear';
  line?: CaptionLine;
}

export class StubAdapter implements OutputAdapter {
  readonly name: string;
  readonly calls: StubCall[] = [];
  private readonly now: () => number;
  private readonly log: boolean;

  constructor(name = 'stub', options: { now?: () => number; log?: boolean } = {}) {
    this.name = name;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? false;
  }

  show(line: CaptionLine): void {
    const at = this.now();
    this.calls.push({ at, action: 'show', line });
    if (this.log) {
      process.stderr.write(`[${at}] ${this.name}: ${line.translation}\n`);
    }
  }

  clear(): void {
    const at = this.now();
    this.calls.push({ at, action: 'clear' });
    if (this.log) process.stderr.write(`[${at}] ${this.name}: <clear>\n`);
  }

  /** Just the shown text, in order — what a test usually wants to assert. */
  shown(): string[] {
    return this.calls
      .filter((call) => call.action === 'show' && call.line)
      .map((call) => call.line!.translation);
  }
}
