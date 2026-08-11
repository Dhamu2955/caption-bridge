import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_ENV, resolveToken } from '../src/web/token.js';

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'bridge-token-')), '.env');
}

describe('URL token', () => {
  it('uses an explicit --token without writing anything', async () => {
    const path = await scratch();
    const result = await resolveToken('chosen-by-hand', path, {});
    expect(result).toMatchObject({ token: 'chosen-by-hand', created: false });
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('reuses the token already in the environment', async () => {
    // This is what keeps the tablet's bookmark alive across a restart.
    const path = await scratch();
    const result = await resolveToken(undefined, path, { [TOKEN_ENV]: 'from-env' });
    expect(result.token).toBe('from-env');
    expect(result.created).toBe(false);
  });

  it('mints one and saves it when there is none', async () => {
    const path = await scratch();
    const env: NodeJS.ProcessEnv = {};
    const result = await resolveToken(undefined, path, env);

    expect(result.created).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{16}$/);
    // Written to disk *and* to this process, since the rest of the run reads
    // process.env rather than the file.
    expect(env[TOKEN_ENV]).toBe(result.token);
    expect(await readFile(path, 'utf8')).toContain(`${TOKEN_ENV}=${result.token}`);
  });

  it('fills in the blank line .env.example ships with', async () => {
    const path = await scratch();
    await writeFile(path, `# a comment worth keeping\n${TOKEN_ENV}=\nSONIOX_API_KEY=abc\n`);
    const result = await resolveToken(undefined, path, { [TOKEN_ENV]: '' });

    const text = await readFile(path, 'utf8');
    expect(text).toContain(`${TOKEN_ENV}=${result.token}`);
    expect(text).toContain('# a comment worth keeping');
    expect(text).toContain('SONIOX_API_KEY=abc');
  });

  it('still serves when the file cannot be written', async () => {
    // A read-only checkout is not a reason to refuse to caption a service.
    const result = await resolveToken(undefined, '/does/not/exist/.env', {});
    expect(result.token).toMatch(/^[0-9a-f]{16}$/);
    expect(result.persisted).toBe(false);
  });
});
