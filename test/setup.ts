import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Give the database tests a DATABASE_URL without needing the shell to be
// sourced first. Without it they skip rather than fail, so `npm test` works
// whether or not Postgres is up.
const dotenv = resolve('.env');
if (existsSync(dotenv)) {
  try {
    process.loadEnvFile(dotenv);
  } catch {
    // Ignore — the tests that need it will skip.
  }
}
