import type { CaptionLine, OutputAdapter } from '../types.js';

/**
 * Pushes captions to overlay pages over a WebSocket.
 *
 * One adapter per output name. INVARIANT 7: several overlays can share a
 * single Soniox session, each with its own delay — needing a second session to
 * feed another screen would be a design error.
 *
 * DO NOT GIVE THIS CLASS A `close()`. These instances outlive the caption
 * session that feeds them (see `OverlayRegistry`), and `CaptionQueue.close()`
 * calls `adapter.close?.()` on every output. Adding one here would therefore
 * tear down every overlay socket each time captions were stopped, and a vMix
 * Browser input does not reconnect on its own — the screen would simply stay
 * dark for the rest of the service. Blanking is `clear()`, which is safe.
 */

export interface OverlaySocket {
  send(data: string): void;
  readonly open: boolean;
}

export class BrowserAdapter implements OutputAdapter {
  readonly name: string;
  private readonly sockets = new Set<OverlaySocket>();
  /** Replayed to a page that connects mid-service, so a projector rebooting
   *  does not sit blank until the next line. */
  private last: CaptionLine | undefined;
  /** Latest passthrough text, replayed like `last` so a projector that reboots
   *  mid-service does not sit blank until the speaker's next word. */
  private lastRaw: string | undefined;

  constructor(name: string) {
    this.name = name;
  }

  attach(socket: OverlaySocket): () => void {
    this.sockets.add(socket);
    if (this.last) this.sendTo(socket, { type: 'show', line: this.last });
    if (this.lastRaw) this.sendTo(socket, { type: 'raw', text: this.lastRaw });
    return () => this.sockets.delete(socket);
  }

  get connections(): number {
    return this.sockets.size;
  }

  private sendTo(socket: OverlaySocket, message: unknown): void {
    if (!socket.open) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.sockets.delete(socket);
    }
  }

  private broadcast(message: unknown): void {
    for (const socket of this.sockets) {
      if (!socket.open) {
        this.sockets.delete(socket);
        continue;
      }
      this.sendTo(socket, message);
    }
  }

  show(line: CaptionLine): void {
    this.last = line;
    this.broadcast({ type: 'show', line });
  }

  /**
   * Continuous passthrough text, replacing whatever is on screen.
   *
   * Deliberately not `show`: there is no line, no id and nothing to review, and
   * calling it a caption would let it reach code that assumes lines are
   * immutable. See pipeline/rawStream.ts.
   */
  raw(text: string): void {
    this.lastRaw = text;
    this.broadcast({ type: 'raw', text });
  }

  clear(): void {
    this.last = undefined;
    this.lastRaw = undefined;
    this.broadcast({ type: 'clear' });
  }
}
