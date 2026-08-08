import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express, { type RequestHandler } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import type { CaptionLine, QueueEvent } from './types.js';
import type { AudioDevice } from './devices.js';
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

export type OperatorCommandType =
  | 'drop'
  | 'edit'
  | 'hold'
  | 'resume'
  | 'captions-off'
  | 'captions-on';

export interface OperatorCommand {
  type: OperatorCommandType;
  lineId?: string;
  /** The corrected translation, for `edit`. */
  text?: string;
}

const COMMAND_TYPES = new Set<string>([
  'drop',
  'edit',
  'hold',
  'resume',
  'captions-off',
  'captions-on',
]);

/** Anything that is not a command this bridge knows is ignored, not guessed at. */
export function parseOperatorCommand(raw: string): OperatorCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const candidate = parsed as { type?: unknown; lineId?: unknown; text?: unknown };
  if (typeof candidate.type !== 'string' || !COMMAND_TYPES.has(candidate.type)) return undefined;

  return {
    type: candidate.type as OperatorCommandType,
    ...(typeof candidate.lineId === 'string' ? { lineId: candidate.lineId } : {}),
    ...(typeof candidate.text === 'string' ? { text: candidate.text } : {}),
  };
}

export interface PendingLine extends CaptionLine {
  /** Wall-clock instant this line goes to air. Past it, nothing can change it. */
  deadlineAt: number;
  /** When it reached the reviewer feed. The drain bar runs from here to
   *  deadlineAt — using the review window alone leaves the bar pinned full for
   *  the first few seconds, because assembly delay is not review time. */
  visibleFrom: number;
  /** Whether a correction is already queued against it. */
  edited: boolean;
}

/**
 * Everything the reviewer can still act on, soonest deadline first.
 *
 * A list rather than one `current` line: at a three-minute review window there
 * are tens of lines in flight at once, and the reviewer needs to see which one
 * is about to expire.
 */
export interface OperatorView {
  pending: PendingLine[];
  /** Size of the review window, so the page can label it. */
  windowMs: number;
  /**
   * Wall clock for audio position 0, so the page can put a picture where the
   * words are. Absent when nothing is running.
   */
  sessionEpoch?: number;
  /**
   * A recording the reviewer can watch alongside the queue, when the session is
   * being fed from a file rather than a microphone. There is no equivalent for
   * a live service yet — that needs a video feed off the vMix machine.
   */
  media?: { url: string; kind: 'file' } | undefined;
}

export interface BridgeServerOptions {
  host: string;
  port: number;
  /** Overlay adapters by output name. */
  outputs: Map<string, BrowserAdapter>;
  /** Shared secret; omit to run without one on a trusted localhost. */
  token?: string | undefined;
  onCommand?: (command: OperatorCommand) => void;
  /** Audio devices for the control page's dropdown. */
  listDevices?: () => Promise<AudioDevice[]>;
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
    options?: { format?: string },
  ) => Promise<void> | void;
  /** Reported on the control page so the operator can see what is running. */
  sessionStatus?: () => { running: boolean; device?: string | undefined; level?: number };
  /**
   * Mounted ahead of the static pages, so `serve` can add its own routes
   * without this class having to know what they are.
   */
  routers?: RequestHandler[];
}

export class BridgeServer {
  private readonly options: BridgeServerOptions;
  private readonly operators = new Set<WebSocket>();
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private view: OperatorView = { pending: [], windowMs: 0 };

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
    app.get('/', (_req, res) => res.redirect('/operator'));
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
        const body = req.body as { action?: unknown; device?: unknown; format?: unknown };
        const action = body?.action;
        if (action !== 'start' && action !== 'stop' && action !== 'end') {
          res.status(400).json({ error: 'action must be start, stop or end' });
          return;
        }
        const device = typeof body.device === 'string' ? body.device : undefined;
        const format = typeof body.format === 'string' ? body.format : undefined;
        try {
          await this.options.onSession?.(action, device, format ? { format } : undefined);
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

    const base = `http://${this.options.host}:${this.options.port}`;
    const suffix = this.options.token ? `?token=${this.options.token}` : '';

    // §9: the reviewer surface carries broadcast content ahead of air. Reaching
    // it from a tablet means binding to the LAN, which is fine — routing it in
    // from outside is not.
    if (this.options.host !== '127.0.0.1' && this.options.host !== 'localhost') {
      warn(`serving on ${this.options.host} — LAN only, never port-forward this`);
      if (!this.options.token) {
        warn('no token set while bound off-loopback — anyone on the network can drive captions');
      }
    }

    info(`reviewer  ${base}/operator${suffix}`);
    info(`control   ${base}/control${suffix}`);
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
        const command = parseOperatorCommand(raw.toString());
        if (!command) return;
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
