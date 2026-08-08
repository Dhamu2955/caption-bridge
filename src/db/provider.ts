import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrisma, DatabaseError } from './client.js';

/**
 * A database connection that is only made when something actually needs one.
 *
 * The server has to start on a machine where Postgres is not running and
 * `DATABASE_URL` has never been set — that is the whole point of booting bare.
 * So nothing here connects at construction; the first caller that needs a
 * client gets one, and everyone before then gets a clear "not configured yet".
 *
 * `invalidate()` is what makes pasting a database URL into the settings page
 * work without restarting the process.
 */

export type SchemaState = 'ready' | 'missing' | 'unknown';

export interface DatabaseProbe {
  ok: boolean;
  schema: SchemaState;
  error?: string;
}

/** Postgres "relation does not exist" / Prisma "table does not exist". */
const MISSING_TABLE = new Set(['42P01', 'P2021']);

export class PrismaProvider {
  private readonly getUrl: () => string;
  private client: PrismaClient | undefined;
  /** The URL the cached client was built for, so a change is noticed. */
  private builtFor: string | undefined;

  constructor(getUrl: () => string) {
    this.getUrl = getUrl;
  }

  /** Throws `DatabaseError` when the URL is not configured. */
  async get(): Promise<PrismaClient> {
    const url = this.getUrl();
    if (this.client && this.builtFor === url) return this.client;
    await this.invalidate();
    this.client = createPrisma(url);
    this.builtFor = url;
    return this.client;
  }

  /**
   * Is there a database, and does it have the tables?
   *
   * Never throws: this feeds a status page whose job is to report bad news, not
   * to become bad news.
   */
  async probe(timeoutMs = 2000): Promise<DatabaseProbe> {
    let prisma: PrismaClient;
    try {
      prisma = await this.get();
    } catch (err) {
      return { ok: false, schema: 'unknown', error: (err as Error).message };
    }

    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs);
    } catch (err) {
      return { ok: false, schema: 'unknown', error: describe(err) };
    }

    try {
      await withTimeout(prisma.service.count(), timeoutMs);
      return { ok: true, schema: 'ready' };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && MISSING_TABLE.has(code)) {
        return { ok: true, schema: 'missing', error: 'the tables have not been created yet' };
      }
      return { ok: true, schema: 'unknown', error: describe(err) };
    }
  }

  /** Drop the cached client — call when the configured URL changes. */
  async invalidate(): Promise<void> {
    const previous = this.client;
    this.client = undefined;
    this.builtFor = undefined;
    if (previous) await previous.$disconnect().catch(() => {});
  }

  async close(): Promise<void> {
    await this.invalidate();
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Prisma's connection errors run to several paragraphs of ASCII art; the
  // status card has room for a sentence.
  return message.split('\n')[0]!.slice(0, 200);
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DatabaseError(`no response after ${ms}ms — is Postgres running?`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
