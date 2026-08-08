import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeFileAtomic } from '../src/settings/atomic.js';
import {
  EnvWriteError,
  maskSecret,
  readEnvNames,
  upsertEnv,
  writeSecrets,
} from '../src/settings/env.js';

/**
 * The one place in this project that can destroy something a person wrote by
 * hand. `.env` is built from `.env.example`, which is mostly explanation, so
 * "preserves the comments" is the requirement, not a nicety.
 */

const SAMPLE = [
  '# Soniox API key. Never put this in config.json — config.json is committed.',
  'SONIOX_API_KEY=sk-old-value',
  '',
  '# Local Postgres from docker-compose.yml. Localhost only (SPEC §9).',
  'DATABASE_URL=postgresql://localhost:5433/captions',
  '',
  '# IMPORTANT: set the OAuth consent screen to "Production", not "Testing".',
  'YOUTUBE_CLIENT_ID=',
  '',
].join('\n');

describe('upsertEnv', () => {
  it('rewrites a key in place, keeping the comment above it', () => {
    const result = upsertEnv(SAMPLE, { SONIOX_API_KEY: 'sk-new-value' });

    const lines = result.split('\n');
    expect(lines[0]).toContain('Never put this in config.json');
    expect(lines[1]).toBe('SONIOX_API_KEY=sk-new-value');
    // Everything downstream is untouched.
    expect(result).toContain('# IMPORTANT: set the OAuth consent screen');
    expect(result).toContain('DATABASE_URL=postgresql://localhost:5433/captions');
  });

  it('leaves the file byte-identical when nothing changes', () => {
    expect(upsertEnv(SAMPLE, {})).toBe(SAMPLE);
  });

  it('appends a key the file has never had', () => {
    const result = upsertEnv(SAMPLE, { YOUTUBE_INGESTION_URL: 'https://upload.test/cc?cid=a' });

    expect(result).toContain('YOUTUBE_INGESTION_URL=https://upload.test/cc?cid=a');
    // Appended, not spliced into somebody else's section.
    expect(result.trimEnd().split('\n').pop()).toBe(
      'YOUTUBE_INGESTION_URL=https://upload.test/cc?cid=a',
    );
    expect(result).toContain('SONIOX_API_KEY=sk-old-value');
  });

  it('fills in a key that is present but empty', () => {
    const result = upsertEnv(SAMPLE, { YOUTUBE_CLIENT_ID: '1234.apps.googleusercontent.com' });
    expect(result).toContain('YOUTUBE_CLIENT_ID=1234.apps.googleusercontent.com');
    expect(result).not.toContain('YOUTUBE_CLIENT_ID=\n');
  });

  it('removes a key on null but keeps its explanation', () => {
    const result = upsertEnv(SAMPLE, { DATABASE_URL: null });
    expect(result).not.toContain('DATABASE_URL=');
    expect(result).toContain('# Local Postgres from docker-compose.yml');
  });

  it('refuses a value containing a line break', () => {
    // Almost always a paste that picked up a trailing line.
    expect(() => upsertEnv(SAMPLE, { SONIOX_API_KEY: 'sk-a\nsk-b' })).toThrow(EnvWriteError);
    expect(() => upsertEnv(SAMPLE, { SONIOX_API_KEY: 'sk-a\r\nsk-b' })).toThrow(/line break/);
  });

  it('does not write anything when one value in the batch is rejected', () => {
    expect(() =>
      upsertEnv(SAMPLE, { DATABASE_URL: 'postgresql://ok', SONIOX_API_KEY: 'bad\nvalue' }),
    ).toThrow(EnvWriteError);
  });

  it('quotes values that would not survive a round trip', () => {
    expect(upsertEnv('', { A: 'has space' })).toContain('A="has space"');
    expect(upsertEnv('', { A: 'trailing ' })).toContain('A="trailing "');
    expect(upsertEnv('', { A: 'with#hash' })).toContain('A="with#hash"');
    expect(upsertEnv('', { A: 'say "hi"' })).toContain('A="say \\"hi\\""');
    // A plain URL is common and needs no quoting — keep it readable.
    expect(upsertEnv('', { A: 'https://upload.test/cc?cid=a&x=1' })).toContain(
      'A=https://upload.test/cc?cid=a&x=1',
    );
  });

  it('handles an export prefix and indentation', () => {
    const result = upsertEnv('  export SONIOX_API_KEY=old\n', { SONIOX_API_KEY: 'new' });
    expect(result).toContain('  SONIOX_API_KEY=new');
  });

  it('keeps CRLF files on CRLF', () => {
    const crlf = 'A=1\r\nB=2\r\n';
    expect(upsertEnv(crlf, { A: '9' })).toBe('A=9\r\nB=2\r\n');
  });

  it('ignores a key mentioned only inside a comment', () => {
    const text = '# SONIOX_API_KEY=example\nOTHER=1\n';
    const result = upsertEnv(text, { SONIOX_API_KEY: 'real' });
    expect(result).toContain('# SONIOX_API_KEY=example');
    expect(result).toContain('SONIOX_API_KEY=real');
  });
});

describe('readEnvNames', () => {
  it('lists the variables the file defines, in order', () => {
    expect(readEnvNames(SAMPLE)).toEqual([
      'SONIOX_API_KEY',
      'DATABASE_URL',
      'YOUTUBE_CLIENT_ID',
    ]);
  });

  it('does not count commented-out lines', () => {
    expect(readEnvNames('# A=1\nB=2\n')).toEqual(['B']);
  });
});

describe('maskSecret', () => {
  it('shows just enough to tell two keys apart', () => {
    expect(maskSecret('sk-abcdefgh1234')).toBe('…1234');
    expect(maskSecret('abc')).toBe('…');
    expect(maskSecret('   ')).toBe('');
  });
});

describe('writeSecrets', () => {
  it('creates the file on the first secret, readable only by its owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caption-env-'));
    const path = join(dir, '.env');

    await writeSecrets(path, { SONIOX_API_KEY: 'sk-first' });

    expect(await readFile(path, 'utf8')).toContain('SONIOX_API_KEY=sk-first');
    // This file holds every credential the bridge has.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('backs up the previous contents before overwriting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caption-env-'));
    const path = join(dir, '.env');
    await writeFile(path, SAMPLE, 'utf8');

    await writeSecrets(path, { SONIOX_API_KEY: 'sk-second' });

    expect(await readFile(path, 'utf8')).toContain('sk-second');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe(SAMPLE);
  });

  it('does not touch the file when the value is unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caption-env-'));
    const path = join(dir, '.env');
    await writeFile(path, SAMPLE, 'utf8');
    const before = await stat(path);

    await writeSecrets(path, { SONIOX_API_KEY: 'sk-old-value' });

    expect(await readFile(path, 'utf8')).toBe(SAMPLE);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe('writeFileAtomic', () => {
  it('leaves no temp files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caption-atomic-'));
    const path = join(dir, 'config.json');

    await writeFileAtomic(path, '{"a":1}\n');

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('serialises concurrent writes to the same path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caption-atomic-'));
    const path = join(dir, 'config.json');

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeFileAtomic(path, `value-${i}\n`)),
    );

    // Whichever won, the file is one complete write and never a mixture.
    expect(await readFile(path, 'utf8')).toMatch(/^value-\d+\n$/);
  });

  it('preserves the mode of an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caption-atomic-'));
    const path = join(dir, '.env');
    await writeFileAtomic(path, 'A=1\n', { mode: 0o600 });

    await writeFileAtomic(path, 'A=2\n');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
