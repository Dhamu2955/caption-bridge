import type { CaptionLine, OutputAdapter } from '../types.js';

/**
 * Pushes captions to overlay pages over a WebSocket.
 *
 * One adapter per output name. INVARIANT 7: several overlays can share a
 * single Soniox session, each with its own delay — needing a second session to
 * feed another screen would be a design error.
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

  constructor(name: string) {
    this.name = name;
  }

  attach(socket: OverlaySocket): () => void {
    this.sockets.add(socket);
    if (this.last) this.sendTo(socket, { type: 'show', line: this.last });
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

  clear(): void {
    this.last = undefined;
    this.broadcast({ type: 'clear' });
  }
}
