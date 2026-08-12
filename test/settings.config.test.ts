import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigStore } from '../src/settings/configStore.js';
import { looksLikeSecret, restartRequiredFor, SETTINGS } from '../src/settings/schema.js';

/**
 * A settings page has to be safe to press Save on. That means two things: a bad
 * value is refused with a message rather than accepted and crashed on later,
 * and a refusal leaves the file exactly as it was.
 */

const GOOD = JSON.stringify(
  { ingest: { pauseMs: 4000, maxLines: 3 }, live: { maxBufferMs: 8000 } },
  null,
  2,
);

async function store(contents?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'caption-config-'));
  const path = join(dir, 'config.json');
  if (contents !== undefined) await writeFile(path, `${contents}\n`, 'utf8');
  return { path, store: new ConfigStore(path) };
}

describe('ConfigStore', () => {
  it('applies a valid change and re-parses it', async () => {
    const { path, store: config } = await store(GOOD);

    const result = await config.update({ 'ingest.pauseMs': 2500 });

    expect(result.ok).toBe(true);
    expect(config.current.ingest.pauseMs).toBe(2500);
    expect(JSON.parse(await readFile(path, 'utf8')).ingest.pauseMs).toBe(2500);
  });

  it('refuses an invalid value and leaves the file byte-identical', async () => {
    const { path, store: config } = await store(GOOD);
    const before = await readFile(path, 'utf8');

    // maxSegmentMs below minDisplayMs — parseConfig rejects this pairing.
    const result = await config.update({ 'ingest.maxSegmentMs': 10 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('minDisplayMs');
    expect(await readFile(path, 'utf8')).toBe(before);
    // And the running config is untouched, so nothing is half-applied.
    expect(config.current.ingest.maxSegmentMs).not.toBe(10);
  });

  it('refuses a setting it does not know', async () => {
    const { store: config } = await store(GOOD);
    const result = await config.update({ 'ingest.somethingInvented': 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown setting');
  });

  it('refuses a credential pasted into the wrong box', async () => {
    const { path, store: config } = await store(GOOD);
    const before = await readFile(path, 'utf8');

    // config.json is committed; a key in it would be published to the repo.
    const result = await config.update({ 'server.host': 'sk-abcdefghijklmnopqrstuvwxyz012345' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('.env');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('only writes what changed, not every default', async () => {
    const { path, store: config } = await store(GOOD);

    await config.update({ 'ingest.pauseMs': 2500 });

    const written = JSON.parse(await readFile(path, 'utf8'));
    // The file stays the short, readable thing a person wrote.
    expect(Object.keys(written)).toEqual(['ingest', 'live']);
    expect(written.search).toBeUndefined();
  });

  it('keeps a backup of what it replaced', async () => {
    const { path, store: config } = await store(GOOD);
    await config.update({ 'ingest.pauseMs': 2500 });
    expect(await readFile(`${path}.bak`, 'utf8')).toBe(`${GOOD}\n`);
  });

  it('starts on defaults when there is no file, and writes one on first save', async () => {
    const { path, store: config } = await store();

    expect(config.isMissing).toBe(true);
    expect(config.error).toBeUndefined();
    expect(config.current.ingest.maxLines).toBe(2);

    await config.update({ 'ingest.maxLines': 3 });
    expect(JSON.parse(await readFile(path, 'utf8')).ingest.maxLines).toBe(3);
  });

  it('serves defaults and reports why when the file is malformed', async () => {
    const { store: config } = await store('{ this is not json');

    expect(config.error).toBeTruthy();
    expect(config.usingDefaults).toBe(true);
    // Still usable — the page that shows the error has to be able to load.
    expect(config.current.ingest.pauseMs).toBeGreaterThan(0);
  });

  it('will not merge into a file it could not parse', async () => {
    const { path, store: config } = await store('{ broken');
    const before = await readFile(path, 'utf8');

    const result = await config.update({ 'ingest.pauseMs': 2500 });

    // Overwriting a hand-edited file with our guess would be worse than saying no.
    expect(result.ok).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('resetting backs up the broken file and writes defaults', async () => {
    const { path, store: config } = await store('{ broken');

    await config.reset();

    expect(await readFile(`${path}.bak`, 'utf8')).toContain('broken');
    expect(config.error).toBeUndefined();
    expect(JSON.parse(await readFile(path, 'utf8')).ingest.pauseMs).toBeGreaterThan(0);
  });

  it('refuses a save based on a stale view of the file', async () => {
    const { path, store: config } = await store(GOOD);

    // Someone edited it in a text editor while the page was open.
    await writeFile(path, JSON.stringify({ ingest: { pauseMs: 9999 } }, null, 2), 'utf8');

    const result = await config.update({ 'ingest.pauseMs': 2500 }, { expectedMtimeMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed on disk');
  });

  it('notices a change made outside the app', async () => {
    const { path, store: config } = await store(GOOD);
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(path, JSON.stringify({ ingest: { pauseMs: 7777 } }, null, 2), 'utf8');

    expect(config.reloadIfChanged()).toBe(true);
    expect(config.current.ingest.pauseMs).toBe(7777);
  });
});

describe('settings schema', () => {
  it('flags the settings that need a restart', () => {
    // Rebinding the socket would strand every page already open, including the
    // one that asked for the change.
    expect(restartRequiredFor(['server.port', 'ingest.pauseMs'])).toEqual(['server.port']);
  });

  it('gives every setting a label and an explanation', () => {
    for (const setting of SETTINGS) {
      expect(setting.label, setting.path).toBeTruthy();
      expect(setting.help, setting.path).toBeTruthy();
    }
  });

  it('exposes every setting the config actually reads', () => {
    // A setting that exists in config.json but not here is one nobody can
    // change from the app, which is where this machine is set up from.
    const paths = SETTINGS.map((setting) => setting.path);
    for (const path of ['server.host', 'server.port', 'server.shareTokenOnLan']) {
      expect(paths, path).toContain(path);
    }
  });

  it('spots things that belong in .env', () => {
    expect(looksLikeSecret('sk-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeSecret('postgresql://user:pass@localhost:5433/db')).toBe(true);
    expect(looksLikeSecret('./media')).toBe(false);
    expect(looksLikeSecret(4000)).toBe(false);
  });
});
