import { randomBytes } from 'node:crypto';

import { writeSecrets } from '../settings/env.js';
import { warn } from '../util/log.js';

/**
 * The URL token, kept the same between restarts.
 *
 * It used to be minted fresh on every start, which is right for a one-off
 * `live` run and wrong for the machine that serves the homepage: a bookmark on
 * the tablet, a vMix Browser input pointed at an overlay, and the link somebody
 * saved on the office PC all break the moment the bridge is restarted — and
 * they break by showing nothing, on a Sunday, to whoever is least able to fix
 * it.
 *
 * So it lands in `.env` beside every other credential (gitignored, 0600) and is
 * read back from there. `--token` still wins for a one-off, and exporting
 * BRIDGE_TOKEN in the shell still wins over the file.
 */

export const TOKEN_ENV = 'BRIDGE_TOKEN';

export interface ResolvedToken {
  token: string;
  /** True when this run had to mint one, so startup can say the links changed. */
  created: boolean;
  /** False when it could not be written — the token still works, just for now. */
  persisted: boolean;
}

export async function resolveToken(
  explicit?: string | undefined,
  envPath = '.env',
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedToken> {
  const given = explicit?.trim();
  if (given) return { token: given, created: false, persisted: false };

  const existing = env[TOKEN_ENV]?.trim();
  if (existing) return { token: existing, created: false, persisted: true };

  const token = randomBytes(8).toString('hex');
  try {
    await writeSecrets(envPath, { [TOKEN_ENV]: token });
    // The rest of the process reads process.env, not the file.
    env[TOKEN_ENV] = token;
    return { token, created: true, persisted: true };
  } catch (err) {
    // A read-only checkout is not a reason to refuse to serve. The token holds
    // for this run; the links simply change on the next one.
    warn(`could not save the URL token to ${envPath}: ${(err as Error).message}`);
    return { token, created: true, persisted: false };
  }
}
