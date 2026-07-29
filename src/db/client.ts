import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 7 takes the connection through a driver adapter rather than a URL in
 * the schema, so the URL is resolved here from the env var named by
 * `database.urlEnv` in config.json (§5). Never hardcoded, never in config.
 */
export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export class DatabaseError extends Error {}

export function resolveDatabaseUrl(
  urlEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env[urlEnv];
  if (!url || url.trim() === '') {
    throw new DatabaseError(
      `${urlEnv} is not set. Start the database with \`docker compose up -d\` ` +
        `and copy .env.example to .env.`,
    );
  }
  return url.trim();
}

/** Runs `fn` with a client and always disconnects, even on failure. */
export async function withPrisma<T>(
  databaseUrl: string,
  fn: (prisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = createPrisma(databaseUrl);
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
