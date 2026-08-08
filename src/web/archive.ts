import { Router, type RequestHandler } from 'express';

import type { AppConfig } from '../config.js';
import { ConfigError } from '../config.js';
import { DatabaseError } from '../db/client.js';
import type { PrismaProvider } from '../db/provider.js';
import { EditsWouldBeLostError } from '../db/services.js';
import { editTranslation, listAllServices, showSegments } from '../commands/edit.js';
import { exportSrt } from '../commands/export.js';
import type { CheckId } from '../live/preflight.js';

/**
 * The recorded-sermon workflow, over HTTP.
 *
 * These wrap the same functions the CLI calls rather than reimplementing
 * anything — a second copy of "which cue is that, and what did it used to say"
 * would drift, and the CLI is what a year of Sundays has tuned.
 *
 * The rule that shapes all of them: a machine with no database must get a
 * card saying so, not a stack trace. `notConfigured` maps the two errors that
 * mean "not set up yet" onto the same check ids the status endpoint uses, so
 * the page can render them with the code it already has.
 */

export interface ArchiveRouterOptions {
  getConfig: () => AppConfig;
  database: PrismaProvider;
  guard: RequestHandler;
}

/** 503 with a check id, rather than a 500 with a stack. */
function notConfigured(err: unknown): { status: number; body: { error: string; check?: CheckId } } | undefined {
  if (err instanceof DatabaseError) {
    return { status: 503, body: { error: err.message, check: 'database' } };
  }
  if (err instanceof ConfigError) {
    return { status: 503, body: { error: err.message, check: 'config' } };
  }
  return undefined;
}

export function createArchiveRouter(options: ArchiveRouterOptions): Router {
  const router = Router();
  const { guard, database, getConfig } = options;

  /** Every handler needs a client and the same error shaping; do it once. */
  const withDb =
    (handler: (prisma: Awaited<ReturnType<PrismaProvider['get']>>, req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler =>
    (req, res) => {
      void (async () => {
        try {
          const prisma = await database.get();
          await handler(prisma, req, res);
        } catch (err) {
          const mapped = notConfigured(err);
          if (mapped) {
            res.status(mapped.status).json(mapped.body);
            return;
          }
          if (err instanceof EditsWouldBeLostError) {
            res.status(409).json({ error: err.message });
            return;
          }
          // A missing service is the operator naming the wrong file, not a
          // fault — it reads better as a 404 than as a server error.
          const message = (err as Error).message;
          const status = /no service found/i.test(message) ? 404 : 500;
          res.status(status).json({ error: message });
        }
      })();
    };

  router.get(
    '/api/services',
    guard,
    withDb(async (prisma, _req, res) => {
      res.json({ services: await listAllServices(prisma) });
    }),
  );

  router.get(
    '/api/services/:ref/segments',
    guard,
    withDb(async (prisma, req, res) => {
      const from = Number(req.query['from'] ?? 1);
      const limit = Math.min(Number(req.query['limit'] ?? 50), 500);
      const result = await showSegments(
        {
          ref: decodeURIComponent(req.params['ref'] as string),
          from: Number.isFinite(from) ? from : 1,
          limit: Number.isFinite(limit) ? limit : 50,
        },
        prisma,
      );
      res.json({
        service: {
          id: result.service.id,
          speaker: result.service.speaker,
          videoPath: result.service.videoPath,
          youtubeVideoId: result.service.youtubeVideoId,
        },
        total: result.total,
        // Cue numbers are 1-based, matching the SRT and what VLC shows.
        rows: result.rows.map((row, index) => ({
          cue: (Number.isFinite(from) ? from : 1) + index,
          original: row.original,
          translation: row.translation,
          startMs: row.startMs,
          endMs: row.endMs,
          editedBy: row.editedBy,
          editedAt: row.editedAt,
          previousTranslation: row.previousTranslation,
        })),
      });
    }),
  );

  router.patch(
    '/api/services/:ref/segments/:cue',
    guard,
    withDb(async (prisma, req, res) => {
      const body = req.body as { text?: unknown };
      const cue = Number(req.params['cue']);
      if (!Number.isInteger(cue) || cue < 1) {
        res.status(400).json({ error: 'cue must be a whole number, counting from 1' });
        return;
      }
      if (typeof body?.text !== 'string' || body.text.trim() === '') {
        res.status(400).json({ error: 'text is required' });
        return;
      }

      const result = await editTranslation(
        {
          ref: decodeURIComponent(req.params['ref'] as string),
          cue,
          text: body.text,
          // Until there are accounts, every correction is simply "a person".
          editedBy: 'local',
        },
        prisma,
      );
      res.json(result);
    }),
  );

  router.post(
    '/api/services/:ref/export',
    guard,
    withDb(async (prisma, req, res) => {
      // Fast enough to answer inline — no job needed.
      const result = await exportSrt(
        { ref: decodeURIComponent(req.params['ref'] as string) },
        getConfig(),
        prisma,
      );
      res.json(result);
    }),
  );

  return router;
}
