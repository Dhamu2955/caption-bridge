import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, env } from 'prisma/config';

// Load .env the same way the CLI does, without pulling in dotenv.
// A shell export still wins, matching src/cli.ts.
const dotenv = resolve('.env');
if (existsSync(dotenv)) {
  try {
    process.loadEnvFile(dotenv);
  } catch {
    // A malformed .env should not stop `prisma --help` from working.
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
