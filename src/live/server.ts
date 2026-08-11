import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express, { type RequestHandler } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import type { CaptionLine, QueueEvent } from './types.js';
import type { AudioDevice } from './devices.js';
import type { BrowserAdapter } from './adapters/browser.js';
import { displayHost, isLoopback } from '../util/addresses.js';
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

export interface BridgeServerOptions {
  host: string;
  port: number;
  /** Overlay adapters by output name. */
  outputs: Map<string, BrowserAdapter>;
  /** Shared secret; omit to run without one on a trusted localhost. */
  token?: string | undefined;
  /** Audio devices for the control page's dropdown. */
  listDevices?: () => Promise<AudioDevice[]>;
  /**
   * PCM arriving from a browser that captured it itself (`format: 'browser'`).
   * Returns false when no session is listening, so the page can stop sending
   * rather than shouting into a closed room.
   */
  onAudio?: (chunk: Buffer) => boolean;
  /**
   * Start and stop capture from the control page.
   *
   * `start` and `stop` are capture-only — `stop` leaves the queue draining so
   * everything already spoken still reaches air. `end` tears the session down
   * and discards that backlog, which is why it is a separate word.
   */
  onSession?: (
    action: 'start' | 'stop' | 'end',
    device?: string,
    options?: { format?: string; channel?: number },
  ) => Promise<void> | void;
  /** Reported on the control page so the operator can see what is running. */
  sessionStatus?: () => {
    running: boolean;
    device?: string | undefined;
    level?: number;
    channel?: number | undefined;
    captureError?: string | null;
  };
  /**
   * Mounted ahead of the static pages, so `serve` can add its own routes
   * without this class having to know what they are.
   */
  routers?: RequestHandler[];
}

export class BridgeServer {
  private readonly options: BridgeServerOptions;
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;

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

    app.use(express.json({ limit: '16kb' }));

    // Ahead of the static handler so a route can shadow a page if it ever
    // needs to, and so `serve` can add endpoints without editing this class.
    for (const router of this.options.routers ?? []) app.use(router);

    app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
    // The front door, served at `/` rather than redirected to, so the address
    // somebody types on a tablet is the address that stays in the bar and gets
    // bookmarked — token and all.
    app.get('/', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'home.html')));
    app.get('/healthz', (_req, res) => res.json({ ok: true }));

    /**
     * The first HTTP endpoints on this server that need the token — until now
     * it was checked only on the WebSocket upgrade, because the pages
     * themselves must stay reachable without one (§9: a vMix Browser input
     * cannot log in, and a redirect to a login form kills captions on air).
     * These do more than serve markup, so they are gated.
     */
    const guard: RequestHandler = (req, res, next) => {
      if (!this.options.token || req.query['token'] === this.options.token) {
        next();
        return;
      }
      res.status(401).json({ error: 'bad or missing token' });
    };

    app.get('/api/devices', guard, (_req, res) => {
      void (async () => {
        if (!this.options.listDevices) {
          res.json({ devices: [] });
          return;
        }
        try {
          res.json({ devices: await this.options.listDevices() });
        } catch (err) {
          res.status(500).json({ error: (err as Error).message });
        }
      })();
    });

    app.get('/api/session', guard, (_req, res) => {
      res.json(this.options.sessionStatus?.() ?? { running: false });
    });

    app.post('/api/session', guard, (req, res) => {
      void (async () => {
        const body = req.body as {
          action?: unknown;
          device?: unknown;
          format?: unknown;
          channel?: unknown;
        };
        const action = body?.action;
        if (action !== 'start' && action !== 'stop' && action !== 'end') {
          res.status(400).json({ error: 'action must be start, stop or end' });
          return;
        }
        const device = typeof body.device === 'string' ? body.device : undefined;
        const format = typeof body.format === 'string' ? body.format : undefined;

        // Absent and "mix everything" are the same thing, and both have to
        // survive the round trip — sending 0 or null must not be read as
        // channel 1, which would silently take the wrong input.
        let channel: number | undefined;
        if (body.channel !== undefined && body.channel !== null && body.channel !== '') {
          channel = Number(body.channel);
          if (!Number.isInteger(channel) || channel < 1) {
            res.status(400).json({ error: 'channel must be a whole number from 1 up' });
            return;
          }
        }

        try {
          await this.options.onSession?.(action, device, { ...(format ? { format } : {}), ...(channel ? { channel } : {}) });
          res.json(this.options.sessionStatus?.() ?? { running: action === 'start' });
        } catch (err) {
          res.status(500).json({ error: (err as Error).message });
        }
      })();
    });

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

    // Never print the bind address: 0.0.0.0 means "every interface", and it is
    // not a host anybody can dial.
    const base = `http://${displayHost(this.options.host)}:${this.options.port}`;
    const suffix = this.options.token ? `?token=${this.options.token}` : '';

    // §9: the reviewer surface carries broadcast content ahead of air. Reaching
    // it from a tablet means binding to the LAN, which is fine — routing it in
    // from outside is not.
    if (!isLoopback(this.options.host)) {
      warn(`serving on ${this.options.host} — LAN only, never port-forward this`);
      if (!this.options.token) {
        warn('no token set while bound off-loopback — anyone on the network can drive captions');
      }
    }

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

    // s16le mono at the session's sample rate, framed however the page's audio
    // worklet produces it. Binary only — a text frame here is a bug, not audio.
    if (role === 'capture') {
      let warned = false;
      ws.on('message', (raw, isBinary) => {
        if (!isBinary) return;
        const chunk = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
        const accepted = this.options.onAudio?.(chunk) ?? false;
        if (!accepted && !warned) {
          warned = true;
          // Told once, so the page can show it and stop; a closing socket
          // mid-service would otherwise look like a network fault.
          ws.send(JSON.stringify({ type: 'idle' }));
        }
        if (accepted) warned = false;
      });
      return;
    }

    ws.close();
  }

  async stop(): Promise<void> {
    this.wss?.close();
    await new Promise<void>((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
    });
  }
}
