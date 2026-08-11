import { Router, type RequestHandler } from 'express';

import type { AppConfig, LoadedConfig } from '../config.js';
import { resolveDatabaseUrl } from '../db/client.js';
import { PrismaProvider } from '../db/provider.js';
import { createArchiveRouter } from '../web/archive.js';
import { createGlossaryRouter } from '../web/glossary.js';
import { ConfigStore } from '../settings/configStore.js';
import { SecretsService } from '../settings/secrets.js';
import { SETTINGS, SETTING_GROUPS } from '../settings/schema.js';
import { YoutubeLiveAdapter, checkIngestionUrl } from '../live/adapters/youtubeLive.js';
import type { CaptureFormat } from '../live/capture.js';
import { listAudioDevices } from '../live/devices.js';
import { capabilitiesFrom, PreflightChecks } from '../live/preflight.js';
import { QueueCounters } from '../live/counters.js';
import { probeInput } from '../live/probe.js';
import { BrowserAdapter } from '../live/adapters/browser.js';
import { BridgeServer } from '../live/server.js';
import { LiveSessionManager, NotConfiguredError } from '../live/sessionManager.js';
import { listAllServices } from './edit.js';
import { resolveToken } from '../web/token.js';
import { isLoopback, isPrivateAddress, lanAddresses, reachableHosts } from '../util/addresses.js';
import { openInBrowser } from '../util/open.js';
import { info, warn } from '../util/log.js';

export interface ServeArgs {
  format?: CaptureFormat | undefined;
  token?: string | undefined;
  /** Open the homepage in a browser once the server is listening. */
  open?: boolean;
  verbose?: boolean;
}

/** Kept short: the homepage is a signpost, not the Sermons tab. */
const HOME_SERVICES = 8;

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

  // Stable between restarts, so the tablet's bookmark and the vMix Browser
  // input survive one. See web/token.ts.
  const { token, created: tokenCreated } = await resolveToken(args.token);
  // One screen, made here and never replaced: a socket is bound to this
  // instance at upgrade time, so a session that swapped it would leave every
  // vMix Browser input attached to an orphan.
  const overlay = new BrowserAdapter('captions');
  const startedAt = Date.now();

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
    overlay,
    defaults: {
      format: args.format,
      verbose: args.verbose ?? false,
    },
    // Read at start time, so a URL pasted into Settings is picked up by the
    // next session without restarting anything.
    getYoutubeCaptionsUrl: () => secrets.get('live.youtubeCaptionsUrlEnv'),
  });

  const counters = new QueueCounters();

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
        overlay: { connections: overlay.connections },
      });
    })();
  });

  /**
   * Hands the token to a browser that is already inside the network.
   *
   * This is what makes the homepage worth having. Without it the front door is
   * locked by the very thing it exists to hand out: to read the tokenised
   * links you would first have to type a tokenised link, sixteen hex
   * characters of it, off a terminal in another room.
   *
   * So the only address anyone has to remember is the short one —
   * `http://192.168.1.42:3000` — and every link on the page beyond it is
   * complete and one click away.
   *
   * Ungated except by the network itself, which is a deliberate trade and the
   * same one the overlay makes (§9): being on the mandir LAN is the
   * credential. The socket address is what decides it, never a header — but a
   * router that forwards this port would hand the token to the internet, which
   * is why the README says not to and why `server.shareTokenOnLan` exists to
   * turn this off.
   */
  api.get('/api/token', (req, res) => {
    if (!getConfig().server.shareTokenOnLan) {
      res.status(404).json({ error: 'the homepage is not handing out the token on this machine' });
      return;
    }
    if (!isPrivateAddress(req.socket.remoteAddress ?? undefined)) {
      res.status(403).json({ error: 'not on this network' });
      return;
    }
    res.json({ token });
  });

  /**
   * Everything the homepage shows, in one request.
   *
   * Deliberately not four calls to the four endpoints that already exist: this
   * page is left open on a spare screen and polls forever, and one round trip
   * that degrades in parts beats four that fail independently. Every section
   * of it can come back empty — a machine with no database still gets a
   * homepage with working links on it.
   */
  api.get('/api/home', guard, (_req, res) => {
    void (async () => {
      store.reloadIfChanged();
      const config = getConfig();
      const checks = await preflight.all();

      const addresses = lanAddresses();
      const hosts = reachableHosts(config.server.host, addresses);

      let services: unknown = null;
      let servicesError: string | null = null;
      let archive: { services: number; cues: number } | null = null;
      try {
        const prisma = await database.get();
        const all = await listAllServices(prisma);
        services = all.slice(0, HOME_SERVICES);
        archive = { services: all.length, cues: await prisma.segment.count() };
      } catch (err) {
        servicesError = (err as Error).message;
      }

      res.json({
        server: {
          host: config.server.host,
          port: config.server.port,
          loopbackOnly: isLoopback(config.server.host),
          shareTokenOnLan: config.server.shareTokenOnLan,
          urls: hosts.map((host) => ({
            url: `http://${host}:${config.server.port}/`,
            kind: isLoopback(host) ? 'loopback' : 'lan',
          })),
        },
        startedAt,
        session: manager.status,
        live: counters.snapshot,
        overlay: { connections: overlay.connections },
        checks,
        capabilities: capabilitiesFrom(checks),
        archive,
        services,
        servicesError,
      });
    })();
  });

  api.get('/api/stats', guard, (_req, res) => {
    void (async () => {
      const session = manager.status;
      const live = {
        ...counters.snapshot,
        state: session.state,
        startedAt: session.startedAt ?? null,
        runningForMs: session.startedAt ? Date.now() - session.startedAt : 0,
      };

      // The archive half needs Postgres. Without it the live half is still
      // worth showing, so this degrades rather than failing.
      let archive: unknown = null;
      let archiveError: string | null = null;
      try {
        const prisma = await database.get();
        const [services, cues, corrected, published, durations] = await Promise.all([
          prisma.service.count(),
          prisma.segment.count(),
          prisma.segment.count({ where: { editedAt: { not: null } } }),
          prisma.service.count({ where: { youtubeVideoId: { not: null } } }),
          prisma.service.aggregate({ _sum: { durationMs: true } }),
        ]);
        archive = {
          services,
          cues,
          correctedCues: corrected,
          servicesOnYoutube: published,
          // The closest thing to a Soniox usage figure that exists: every
          // ingest records the audio it was billed for.
          transcribedMs: durations._sum.durationMs ?? 0,
        };
      } catch (err) {
        archiveError = (err as Error).message;
      }

      res.json({ live, archive, archiveError });
    })();
  });

  /**
   * Listen to an input for a few seconds and report every channel separately.
   *
   * The one question device capture could never answer: the sound is arriving
   * at this machine, the device is in the list, it opens without complaint —
   * and nothing is transcribed. Per-channel levels turn that into a fact.
   * Sixteen channels with signal on the first is a capture card carrying the
   * sermon on input 1; sixteen channels of digital silence is a cable.
   *
   * Runs its own short ffmpeg, so it can be used while nothing is live and
   * cannot disturb a session that is.
   */
  api.post('/api/input-test', guard, (req, res) => {
    void (async () => {
      const body = req.body as { device?: unknown; format?: unknown; seconds?: unknown };
      const device = typeof body?.device === 'string' ? body.device.trim() : '';
      if (device === '') {
        res.status(400).json({ error: 'choose a sound input to test first' });
        return;
      }

      const seconds = Number(body?.seconds ?? 4);
      try {
        const probe = await probeInput({
          device,
          format: (typeof body?.format === 'string' ? body.format : args.format) as
            | CaptureFormat
            | undefined,
          seconds: Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 10) : 4,
        });
        res.json(probe);
      } catch (err) {
        // 422, not 500: the device was understood and could not be listened to,
        // and the message is the whole point of the endpoint.
        res.status(422).json({ error: (err as Error).message });
      }
    })();
  });

  api.post('/api/checks/refresh', guard, (_req, res) => {
    preflight.refresh();
    res.json({ ok: true });
  });

  api.get('/api/settings', guard, (_req, res) => {
    res.json({
      settings: SETTINGS,
      groups: SETTING_GROUPS,
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
    overlay,
    token,
    routers: [
      api,
      createArchiveRouter({ getConfig, database, guard }),
      createGlossaryRouter({ getConfig, store, guard }),
    ],
    listDevices: () => listAudioDevices(args.format),
    onAudio: (chunk) => manager.current?.pushAudio(chunk) ?? false,
    sessionStatus: () => {
      const status = manager.status;
      return {
        running: status.running,
        device: status.device,
        level: status.level ?? 0,
        channel: status.channel,
        captureError: status.captureError ?? null,
      };
    },
    onSession: async (action, device, options) => {
      try {
        // A new session is a new service. Carrying last week's counts into it
        // would make the numbers meaningless, and starting over is exactly what
        // "start" means.
        if (action === 'start' && manager.status.state === 'idle') counters.reset();
        await manager.handle(action, device, {
          format: options?.format as CaptureFormat | undefined,
          channel: options?.channel,
        });
      } catch (err) {
        // A start that cannot happen yet is a message for the operator, not a
        // stack trace — the route layer turns this into a 500 with the text.
        if (err instanceof NotConfiguredError) throw new Error(err.message);
        throw err;
      }
    },
  });

  // Counts every queue event on its way to the reviewer, so the numbers cost
  // nothing and cannot drift from what actually happened.
  manager.attachSink({
    notify: (event) => {
      counters.record(event);
    },
  });

  await server.start();

  // The homepage last and loudest: it is the only address anyone needs, and the
  // lines the server prints above it are the ones somebody occasionally wants
  // to paste into vMix directly.
  const port = getConfig().server.port;
  const hosts = reachableHosts(getConfig().server.host);
  const share = getConfig().server.shareTokenOnLan;
  // Short when the bridge hands the token out, because then this is an address
  // to be read off a screen and typed on another machine — and sixteen hex
  // characters is exactly what nobody should have to type.
  const urls = hosts.map((host) => `http://${host}:${port}/${share ? '' : `?token=${token}`}`);

  info('');
  info('open this, from here or from any machine on the network:');
  info('');
  for (const url of urls) info(`  ${url}`);
  info('');
  if (share) {
    info('no token needed on this network — the homepage hands out the rest of the links');
  }
  if (isLoopback(getConfig().server.host)) {
    warn('listening on loopback only — set server.host to 0.0.0.0 to reach it from another PC');
  }
  if (tokenCreated) {
    info('the URL token was saved to .env, so copied links keep working after a restart');
  }
  info('Nothing needs to be configured to open it. Press Ctrl+C to stop.');
  info('Closing the page does not stop anything — only Ctrl+C here does.');

  // Loopback for the browser on this machine, when there is one: the LAN
  // address is the one to share, but it is also the one DHCP can change under
  // you, and the local page should never be the thing that fails.
  const localUrl =
    urls.find((url) => url.includes('127.0.0.1')) ??
    urls[0] ??
    `http://127.0.0.1:${port}/`;

  // The browser is detached and unref'd (see util/open.ts): it is a convenience
  // launched by this process, never something this process waits on or dies
  // with. Quitting it mid-service must not cost a single caption.
  if (args.open !== false && localUrl) openInBrowser(localUrl);

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

/** Read a dotted settings path out of the parsed config. */
function readAt(config: AppConfig, path: string): unknown {
  let node: unknown = config;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
