import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import type { CaptionLine, QueueEvent } from './types.js';
import type { BrowserAdapter } from './adapters/browser.js';
import { info, warn } from '../util/log.js';

/**
 * Serves the overlay and reviewer pages and carries the WebSocket traffic.
 *
 * §9: binds to localhost/LAN and authenticates with a token in the URL. The
 * overlay must NEVER redirect to a login form — vMix's Browser input cannot
 * type credentials, and a redirect silently kills captions on air. A bad token
 * therefore closes the socket rather than serving anything interactive.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', '..', 'public');

export interface OperatorCommand {
  type: 'drop' | 'hold' | 'resume' | 'captions-off' | 'captions-on';
  lineId?: string;
}

export interface OperatorView {
  /** The line the reviewer is judging — the one on the reviewer feed now. */
  current:
    | (CaptionLine & {
        /** Wall-clock instant this line goes to air. */
        deadlineAt: number;
        /** Size of the review window, so the bar knows what full looks like. */
        windowMs: number;
      })
    | null;
  upcoming: CaptionLine[];
}

export interface BridgeServerOptions {
  host: string;
  port: number;
  /** Overlay adapters by output name. */
  outputs: Map<string, BrowserAdapter>;
  /** Shared secret; omit to run without one on a trusted localhost. */
  token?: string | undefined;
  onCommand?: (command: OperatorCommand) => void;
}

export class BridgeServer {
  private readonly options: BridgeServerOptions;
  private readonly operators = new Set<WebSocket>();
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private view: OperatorView = { current: null, upcoming: [] };

  constructor(options: BridgeServerOptions) {
    this.options = options;
  }

  private authorised(url: URL): boolean {
    if (!this.options.token) return true;
    return url.searchParams.get('token') === this.options.token;
  }

  async start(): Promise<void> {
    const app = express();
    app.disable('x-powered-by');

    app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
    app.get('/', (_req, res) => res.redirect('/operator'));
    app.get('/healthz', (_req, res) => res.json({ ok: true }));

    const server = createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    this.server = server;
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/ws' || !this.authorised(url)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, url));
    });

    await new Promise<void>((resolvePromise) => {
      server.listen(this.options.port, this.options.host, () => resolvePromise());
    });

    const base = `http://${this.options.host}:${this.options.port}`;
    const suffix = this.options.token ? `?token=${this.options.token}` : '';
    info(`reviewer  ${base}/operator${suffix}`);
    for (const name of this.options.outputs.keys()) {
      info(`overlay   ${base}/overlay${suffix ? `${suffix}&` : '?'}output=${name}`);
    }
  }

  private accept(ws: WebSocket, url: URL): void {
    const role = url.searchParams.get('role');

    if (role === 'overlay') {
      const name = url.searchParams.get('output') ?? 'venue';
      const adapter = this.options.outputs.get(name);
      if (!adapter) {
        warn(`overlay asked for unknown output "${name}"`);
        ws.close();
        return;
      }
      const detach = adapter.attach({
        send: (data) => ws.send(data),
        get open() {
          return ws.readyState === ws.OPEN;
        },
      });
      ws.on('close', detach);
      return;
    }

    if (role === 'operator') {
      this.operators.add(ws);
      ws.send(JSON.stringify({ type: 'state', ...this.view }));
      ws.on('message', (raw) => {
        let command: OperatorCommand;
        try {
          command = JSON.parse(raw.toString()) as OperatorCommand;
        } catch {
          return;
        }
        // Advisory only. The scheduler decides whether to honour it.
        this.options.onCommand?.(command);
      });
      ws.on('close', () => this.operators.delete(ws));
      return;
    }

    ws.close();
  }

  /** Push the reviewer's view. Called whenever the queue changes. */
  publish(view: OperatorView): void {
    this.view = view;
    const payload = JSON.stringify({ type: 'state', ...view });
    for (const ws of this.operators) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
      else this.operators.delete(ws);
    }
  }

  /** Mirror queue activity to the reviewer, for the status line. */
  notify(event: QueueEvent): void {
    const payload = JSON.stringify({ type: 'event', event });
    for (const ws of this.operators) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  get operatorCount(): number {
    return this.operators.size;
  }

  async stop(): Promise<void> {
    this.wss?.close();
    await new Promise<void>((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
    });
  }
}
