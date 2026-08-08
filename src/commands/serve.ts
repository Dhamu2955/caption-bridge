import { randomBytes } from 'node:crypto';

import { Router, type RequestHandler } from 'express';

import type { AppConfig, LoadedConfig } from '../config.js';
import { resolveDatabaseUrl } from '../db/client.js';
import { PrismaProvider } from '../db/provider.js';
import { createArchiveRouter } from '../web/archive.js';
import { ConfigStore } from '../settings/configStore.js';
import { SecretsService } from '../settings/secrets.js';
import { SETTINGS } from '../settings/schema.js';
import { YoutubeLiveAdapter, checkIngestionUrl } from '../live/adapters/youtubeLive.js';
import type { CaptureFormat } from '../live/capture.js';
import { listAudioDevices } from '../live/devices.js';
import { OverlayRegistry, OVERLAY_NAMES } from '../live/overlays.js';
import { capabilitiesFrom, PreflightChecks } from '../live/preflight.js';
import { BridgeServer } from '../live/server.js';
import { LiveSessionManager, NotConfiguredError } from '../live/sessionManager.js';
import { info, warn } from '../util/log.js';

export interface ServeArgs {
  format?: CaptureFormat | undefined;
  token?: string | undefined;
  /** Opened once the server is listening. */
  open?: boolean;
  verbose?: boolean;
}

/**
 * The long-running server behind `npm run dev`.
 *
 * Unlike `live`, this starts with nothing configured: no API key, no database,
 * possibly no ffmpeg. Everything it cannot do yet is reported through
 * `/api/status` as something to fix rather than as a crash, because the machine
 * this runs on is one somebody is still setting up.
 */
export async function runServe(args: ServeArgs, loaded: LoadedConfig): Promise<void> {
  // The store owns config.json from here on; `loaded` is only how the command
  // was told which file to use.
  const store = new ConfigStore(loaded.path);
  const getConfig = () => store.current;

  const token = args.token ?? randomBytes(8).toString('hex');
  const overlays = new OverlayRegistry(OVERLAY_NAMES);

  const database = new PrismaProvider(() =>
    resolveDatabaseUrl(getConfig().database.urlEnv),
  );

  const secrets = new SecretsService(getConfig);
  // A new database URL means the cached client is pointed at the old one.
  secrets.onChange((names) => {
    if (names.includes(getConfig().database.urlEnv)) void database.invalidate();
  });

  const preflight = new PreflightChecks({
    getConfig,
    getConfigError: () => store.error,
    database,
    format: args.format,
  });

  const manager = new LiveSessionManager({
    getConfig,
    overlays,
    defaults: {
      format: args.format,
      verbose: args.verbose ?? false,
      // Every overlay the page offers a URL for, so none of them is a dead
      // link. Outputs are cheap by design (INVARIANT 7) — it is sessions that
      // cost, and there is still only one.
      outputs: [...OVERLAY_NAMES],
    },
    // Read at start time, so a URL pasted into Settings is picked up by the
    // next session without restarting anything.
    getYoutubeCaptionsUrl: () => secrets.get('live.youtubeCaptionsUrlEnv'),
  });

  const api = Router();

  const guard: RequestHandler = (req, res, next) => {
    if (!token || req.query['token'] === token) {
      next();
      return;
    }
    res.status(401).json({ error: 'bad or missing token' });
  };

  api.get('/api/status', guard, (_req, res) => {
    void (async () => {
      // Something else may have edited the file in a text editor.
      store.reloadIfChanged();
      const checks = await preflight.all();
      res.json({
        server: {
          host: getConfig().server.host,
          port: getConfig().server.port,
          loopbackOnly: isLoopback(getConfig().server.host),
        },
        config: {
          path: store.path,
          valid: store.error === undefined,
          usingDefaults: store.usingDefaults,
          error: store.error ?? null,
          mtimeMs: store.mtimeMs ?? null,
        },
        checks,
        capabilities: capabilitiesFrom(checks),
        session: manager.status,
        overlays: overlays.connections(),
        operators: server.operatorCount,
      });
    })();
  });

  api.post('/api/checks/refresh', guard, (_req, res) => {
    preflight.refresh();
    res.json({ ok: true });
  });

  /**
   * The recording the current session is playing in, for the reviewer's player.
   *
   * Takes no path parameter on purpose. It serves whatever file the running
   * session was started with and nothing else, so there is no traversal to
   * defend against — and nothing at all to serve when a real microphone is
   * being used. Unguarded like the overlay, because a video element cannot
   * carry a token any more than a vMix Browser input can.
   */
  api.get('/api/media', (req, res) => {
    const path = manager.current?.mediaPath;
    if (!path) {
      res.status(404).json({ error: 'no recording is playing' });
      return;
    }
    // sendFile handles Range itself, which is what makes the player seekable.
    res.sendFile(path, { acceptRanges: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
    void req;
  });

  api.get('/api/settings', guard, (_req, res) => {
    res.json({
      settings: SETTINGS,
      values: Object.fromEntries(
        SETTINGS.map((setting) => [setting.path, readAt(store.current, setting.path)]),
      ),
      secrets: secrets.list(),
      config: {
        path: store.path,
        mtimeMs: store.mtimeMs ?? null,
        error: store.error ?? null,
        usingDefaults: store.usingDefaults,
      },
    });
  });

  api.put('/api/settings', guard, (req, res) => {
    void (async () => {
      const body = req.body as { patch?: unknown; expectedMtimeMs?: unknown };
      if (typeof body?.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
        res.status(400).json({ error: 'patch must be an object of setting paths to values' });
        return;
      }
      const result = await store.update(body.patch as Record<string, unknown>, {
        expectedMtimeMs:
          typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : undefined,
      });
      if (!result.ok) {
        // 422, not 500: the value was understood and rejected, and nothing was
        // written. The message is the one the CLI would have printed.
        res.status(422).json({ error: result.error });
        return;
      }
      preflight.refresh();
      res.json({
        ok: true,
        mtimeMs: result.mtimeMs ?? null,
        restartRequired: result.restartRequired ?? [],
      });
    })();
  });

  api.put('/api/secrets', guard, (req, res) => {
    void (async () => {
      const body = req.body as { updates?: unknown };
      if (typeof body?.updates !== 'object' || body.updates === null) {
        res.status(400).json({ error: 'updates must be an object of names to values' });
        return;
      }
      try {
        await secrets.set(body.updates as Record<string, string | null>);
        preflight.refresh();
        res.json({ ok: true, secrets: secrets.list() });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })();
  });

  api.post('/api/youtube/test-captions', guard, (req, res) => {
    void (async () => {
      const body = req.body as { url?: unknown };
      const url =
        typeof body?.url === 'string' && body.url.trim() !== ''
          ? body.url.trim()
          : secrets.get('live.youtubeCaptionsUrlEnv');

      if (!url) {
        res.status(400).json({ error: 'no ingestion URL set — paste one on the Settings tab' });
        return;
      }

      const check = checkIngestionUrl(url);
      if (!check.ok) {
        res.status(422).json({ ok: false, error: check.error, warnings: check.warnings });
        return;
      }

      // A real POST, through the same adapter the live path uses — the wire
      // format is the one part of this not verifiable from the code, so the
      // only honest test is to send one and see what YouTube says.
      const errors: string[] = [];
      const adapter = new YoutubeLiveAdapter({
        ingestionUrl: url,
        sessionEpoch: Date.now(),
        onError: (err) => errors.push(err.message),
      });
      await adapter.show({
        id: 'test',
        original: '',
        translation: 'Caption bridge test — you can ignore this line.',
        audioStartMs: 0,
        audioEndMs: 2000,
        speaker: '1',
      });

      res.json({
        ok: errors.length === 0,
        warnings: check.warnings,
        ...(errors.length > 0 ? { error: errors[0] } : {}),
      });
    })();
  });

  const server: BridgeServer = new BridgeServer({
    host: getConfig().server.host,
    port: getConfig().server.port,
    outputs: overlays.map,
    token,
    routers: [api, createArchiveRouter({ getConfig, database, guard })],
    listDevices: () => listAudioDevices(args.format),
    sessionStatus: () => {
      const status = manager.status;
      return {
        running: status.running,
        device: status.device,
        level: status.level ?? 0,
      };
    },
    onSession: async (action, device, options) => {
      try {
        await manager.handle(action, device, {
          format: options?.format as CaptureFormat | undefined,
        });
      } catch (err) {
        // A start that cannot happen yet is a message for the operator, not a
        // stack trace — the route layer turns this into a 500 with the text.
        if (err instanceof NotConfiguredError) throw new Error(err.message);
        throw err;
      }
    },
    onCommand: (command) => manager.command(command),
  });

  manager.attachSink(server);

  await server.start();

  const base = `http://${getConfig().server.host}:${getConfig().server.port}`;
  info('');
  info(`setup     ${base}/app?token=${token}`);
  info('');
  info('Nothing needs to be configured to open it. Press Ctrl+C to stop.');

  await new Promise<void>((resolvePromise) => {
    const shutdown = async () => {
      info('stopping…');
      try {
        await manager.stop();
        await server.stop();
        await database.close();
      } catch (err) {
        warn(`during shutdown: ${(err as Error).message}`);
      }
      resolvePromise();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Read a dotted settings path out of the parsed config. */
function readAt(config: AppConfig, path: string): unknown {
  let node: unknown = config;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
