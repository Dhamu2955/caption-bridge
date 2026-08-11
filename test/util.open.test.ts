import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { launchCommand, openInBrowser } from '../src/util/open.js';

describe('opening the homepage', () => {
  it('uses the right incantation per platform', () => {
    expect(launchCommand('darwin', 'http://x/')).toEqual(['open', ['http://x/']]);
    expect(launchCommand('linux', 'http://x/')).toEqual(['xdg-open', ['http://x/']]);
    // Without the empty title argument, `start` treats the URL as the window
    // title and opens nothing.
    expect(launchCommand('win32', 'http://x/')).toEqual(['cmd', ['/c', 'start', '', 'http://x/']]);
  });

  it('never throws when there is no browser to open', () => {
    // A headless mandir PC still has to serve captions.
    expect(() => openInBrowser('http://127.0.0.1:1/', 'linux')).not.toThrow();
  });

  it('detaches, so quitting the browser cannot reach the bridge', async () => {
    // The single most important line in the file: the process that captions a
    // service must not be a parent waiting on a browser window.
    const source = await readFile(fileURLToPath(new URL('../src/util/open.ts', import.meta.url)), 'utf8');
    expect(source).toContain('detached: true');
    expect(source).toContain('child.unref()');
  });
});
