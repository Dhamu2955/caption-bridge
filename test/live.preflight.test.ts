import { describe, expect, it } from 'vitest';

import { defaultConfig, loadConfigSafe, parseConfig } from '../src/config.js';
import { PrismaProvider } from '../src/db/provider.js';
import { capabilitiesFrom, PreflightChecks, type Check } from '../src/live/preflight.js';

/**
 * The bare-boot contract: on a machine where nothing has been set up, every
 * question has an answer and none of them is an exception.
 */

/** A provider whose URL getter throws, i.e. DATABASE_URL is unset. */
function noDatabase(): PrismaProvider {
  return new PrismaProvider(() => {
    throw new Error('DATABASE_URL is not set');
  });
}

/** Nothing configured: no key, no database, no ffmpeg, no inputs. */
function build() {
  return new PreflightChecks({
    getConfig: () => defaultConfig(),
    database: noDatabase(),
    env: {},
    probeFfmpeg: async () => ({ ok: false, missing: true }),
    listDevices: async () => [],
  });
}

const byId = (checks: Check[], id: string) => checks.find((check) => check.id === id)!;

describe('preflight on an unconfigured machine', () => {
  it('answers every question instead of throwing', async () => {
    const checks = await build().all();
    expect(checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(['config', 'apiKey', 'ffmpeg', 'devices', 'database', 'youtube']),
    );
  });

  it('reports a missing API key with something to do about it', async () => {
    const check = byId(await build().all(), 'apiKey');
    expect(check.state).toBe('missing');
    expect(check.fix).toBeTruthy();
    expect(check.blocks).toContain('live');
  });

  it('does not claim there are no sound inputs when ffmpeg is what is missing', async () => {
    // Otherwise the operator goes looking at cables for a problem that is a
    // missing binary.
    const checks = await build().all();
    expect(byId(checks, 'ffmpeg').state).toBe('missing');
    expect(byId(checks, 'devices').state).toBe('unknown');
    expect(byId(checks, 'devices').detail).toContain('ffmpeg');
  });

  it('does not ask about the schema before the connection works', async () => {
    const checks = await build().all();
    expect(byId(checks, 'database').state).toBe('missing');
    expect(checks.find((check) => check.id === 'dbSchema')).toBeUndefined();
  });

  it('never returns a secret value, only whether one is present', async () => {
    const preflight = new PreflightChecks({
      getConfig: () => defaultConfig(),
      database: noDatabase(),
      env: { SONIOX_API_KEY: 'sk-super-secret-value' },
      probeFfmpeg: async () => ({ ok: true, version: 'ffmpeg 8' }),
      listDevices: async () => [{ name: 'CABLE Output' }],
    });

    const serialised = JSON.stringify(await preflight.all());
    expect(serialised).not.toContain('sk-super-secret-value');
  });

  it('turns blocked checks into capabilities the UI can explain', async () => {
    const capabilities = capabilitiesFrom(await build().all());

    expect(capabilities.live.ready).toBe(false);
    expect(capabilities.live.blockedBy).toContain('apiKey');
    expect(capabilities.archive.blockedBy).toContain('database');
  });

  it('goes green once everything is configured', async () => {
    const preflight = new PreflightChecks({
      getConfig: () => defaultConfig(),
      database: new PrismaProvider(() => 'postgresql://stub'),
      env: {
        SONIOX_API_KEY: 'sk-test',
        YOUTUBE_CLIENT_ID: 'id',
        YOUTUBE_CLIENT_SECRET: 'secret',
        YOUTUBE_REFRESH_TOKEN: 'refresh',
      },
      probeFfmpeg: async () => ({ ok: true, version: 'ffmpeg 8' }),
      listDevices: async () => [{ name: 'CABLE Output' }],
    });

    const checks = await preflight.all();
    expect(byId(checks, 'apiKey').state).toBe('ok');
    expect(byId(checks, 'ffmpeg').state).toBe('ok');
    expect(byId(checks, 'youtube').state).toBe('ok');
  });

  it('caches the slow probes and re-runs them on refresh', async () => {
    let calls = 0;
    const preflight = new PreflightChecks({
      getConfig: () => defaultConfig(),
      database: noDatabase(),
      env: {},
      probeFfmpeg: async () => {
        calls++;
        return { ok: true, version: 'ffmpeg 8' };
      },
      listDevices: async () => [],
    });

    await preflight.all();
    await preflight.all();
    // The control page polls twice a second; spawning ffmpeg that often would
    // be absurd.
    expect(calls).toBe(1);

    preflight.refresh();
    await preflight.all();
    expect(calls).toBe(2);
  });
});

describe('loadConfigSafe', () => {
  it('falls back to defaults when there is no file, and calls that fine', () => {
    const loaded = loadConfigSafe('/nonexistent/config.json');
    expect(loaded.missing).toBe(true);
    // A fresh machine has not written one yet. That is not a fault.
    expect(loaded.error).toBeUndefined();
    expect(loaded.config).toEqual(parseConfig({}));
  });

  it('reads the real config.json in this repo', () => {
    const loaded = loadConfigSafe('config.json');
    expect(loaded.fromFile).toBe(true);
    expect(loaded.error).toBeUndefined();
    expect(loaded.mtimeMs).toBeGreaterThan(0);
  });
});
