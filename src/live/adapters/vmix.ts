import type { CaptionLine, OutputAdapter } from '../types.js';

/**
 * vMix HTTP API adapter.
 *
 * §4 vMix specifics, all of which are load-bearing:
 *  - GT title text fields need `.Text` appended to SelectedName
 *  - reference inputs by GUID, never by number — numbers shift when inputs
 *    are reordered
 *  - rate-limit SetText to ~5/sec; titles chug under heavier load
 *  - VERIFY BY READBACK, not status code. A mistyped SelectedName still
 *    returns 200.
 *
 * The browser overlay is the preferred caption path (§4); this exists for the
 * GT title route and for overlay in/out plus health checks.
 */

export interface VmixAdapterOptions {
  name?: string;
  /** vMix web controller, default http://127.0.0.1:8088 */
  baseUrl?: string;
  /** Input GUID. Never an input number. */
  inputGuid: string;
  /** GT field name WITHOUT the `.Text` suffix — it is appended for you. */
  field?: string;
  /** Minimum gap between SetText calls. ~5/sec. */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class VmixError extends Error {}

export class VmixAdapter implements OutputAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly inputGuid: string;
  private readonly field: string;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastSentAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: VmixAdapterOptions) {
    this.name = options.name ?? 'vmix';
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8088').replace(/\/+$/, '');
    this.inputGuid = options.inputGuid;
    this.field = options.field ?? 'Caption';
    this.minIntervalMs = options.minIntervalMs ?? 200;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  }

  /** The `.Text` suffix is required; without it vMix silently does nothing. */
  selectedName(): string {
    return `${this.field}.Text`;
  }

  private url(params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return `${this.baseUrl}/api/?${query}`;
  }

  private async send(params: Record<string, string>): Promise<string> {
    const response = await this.fetchImpl(this.url(params));
    if (!response.ok) {
      throw new VmixError(`vMix ${params['Function']} failed: ${response.status}`);
    }
    return response.text();
  }

  /** Serialised and rate-limited — titles chug if hammered. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastSentAt);
      if (wait > 0) await this.sleep(wait);
      this.lastSentAt = this.now();
      await fn();
    });
    return this.queue;
  }

  async show(line: CaptionLine): Promise<void> {
    await this.enqueue(async () => {
      await this.send({
        Function: 'SetText',
        Input: this.inputGuid,
        SelectedName: this.selectedName(),
        Value: line.translation,
      });
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.send({
        Function: 'SetText',
        Input: this.inputGuid,
        SelectedName: this.selectedName(),
        Value: '',
      });
    });
  }

  async overlay(action: 'In' | 'Out', channel = 1): Promise<void> {
    await this.enqueue(async () => {
      await this.send({ Function: `OverlayInput${channel}${action}`, Input: this.inputGuid });
    });
  }

  /**
   * Read the field back from vMix's state XML.
   *
   * §4: a 200 proves nothing — a mistyped SelectedName returns 200 and does
   * nothing. This is the only way to know the text actually landed.
   */
  async readBack(): Promise<string | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/`);
    if (!response.ok) throw new VmixError(`vMix state read failed: ${response.status}`);
    return extractTextField(await response.text(), this.inputGuid, this.field);
  }

  async verify(expected: string): Promise<boolean> {
    return (await this.readBack()) === expected;
  }
}

/**
 * Pull one GT text field out of vMix's state XML.
 *
 * Deliberately regex-based rather than pulling in an XML parser: the shape is
 * narrow and fixed, and this keeps the live path dependency-free.
 */
export function extractTextField(
  xml: string,
  inputGuid: string,
  field: string,
): string | undefined {
  const inputPattern = new RegExp(
    `<input\\b[^>]*\\bkey="${escapeRegExp(inputGuid)}"[^>]*>([\\s\\S]*?)</input>`,
    'i',
  );
  const input = inputPattern.exec(xml);
  if (!input?.[1]) return undefined;

  const textPattern = new RegExp(
    `<text\\b[^>]*\\bname="${escapeRegExp(field)}\\.Text"[^>]*>([\\s\\S]*?)</text>`,
    'i',
  );
  const match = textPattern.exec(input[1]);
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
