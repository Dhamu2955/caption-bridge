import { BrowserAdapter } from './adapters/browser.js';
import type { OutputName } from './outputs.js';

/**
 * The overlay adapters, owned by the process rather than by a caption session.
 *
 * This exists because of how the server hands a socket to an adapter: the
 * lookup in `BridgeServer.accept` happens once, at upgrade time, and the socket
 * then belongs to that adapter *instance* forever. Nothing ever re-reads the
 * map for a socket already attached.
 *
 * So if starting a session built fresh adapters, every overlay opened before
 * the restart would keep talking to an orphan — `readyState` still OPEN, the
 * page still looking connected, and not one further caption arriving. That is
 * the worst failure this project can have: invisible until a service is on air,
 * and indistinguishable from "the speaker has not said anything yet".
 *
 * Keeping the adapters here instead means a restart rebinds a new queue to the
 * same objects and no socket ever notices. It works because `BrowserAdapter`
 * holds no session state beyond the line it replays to a page that joins late.
 */

/** Every output an overlay page may ask for when the bridge is serving. */
export const OVERLAY_NAMES: readonly OutputName[] = ['venue', 'stream', 'reviewer', 'overflow'];

export class OverlayRegistry {
  /** The identity passed to `BridgeServerOptions.outputs`. Never replaced. */
  readonly map: Map<string, BrowserAdapter>;

  constructor(names: readonly string[]) {
    this.map = new Map(names.map((name) => [name, new BrowserAdapter(name)]));
  }

  get names(): string[] {
    return [...this.map.keys()];
  }

  get(name: string): BrowserAdapter | undefined {
    return this.map.get(name);
  }

  /**
   * Blank every overlay. Called at a session boundary so a page holds the last
   * line of a finished service rather than freezing on it — and so a page that
   * connects between sessions is not replayed something from the last one.
   */
  async clearAll(): Promise<void> {
    for (const adapter of this.map.values()) await adapter.clear();
  }

  /** Connected pages per output, for the status endpoint. */
  connections(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [name, adapter] of this.map) counts[name] = adapter.connections;
    return counts;
  }
}
