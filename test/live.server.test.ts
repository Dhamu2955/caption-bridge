import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { BridgeServer } from '../src/live/server.js';
import { BrowserAdapter } from '../src/live/adapters/browser.js';
import type { CaptionLine } from '../src/live/types.js';

const line = (id: string, translation: string): CaptionLine => ({
  id,
  original: 'ભક્તિ એ માર્ગ છે.',
  translation,
  audioStartMs: 0,
  audioEndMs: 3000,
  speaker: '1',
});

describe('BrowserAdapter', () => {
  function fakeSocket() {
    const sent: string[] = [];
    return { sent, socket: { send: (data: string) => sent.push(data), open: true } };
  }

  it('broadcasts a line to every attached overlay', () => {
    const adapter = new BrowserAdapter('venue');
    const a = fakeSocket();
    const b = fakeSocket();
    adapter.attach(a.socket);
    adapter.attach(b.socket);

    adapter.show(line('l1', 'Devotion is the path.'));
    for (const socket of [a, b]) {
      expect(JSON.parse(socket.sent[0]!)).toMatchObject({
        type: 'show',
        line: { translation: 'Devotion is the path.' },
      });
    }
  });

  it('replays the current line to a page that connects late', () => {
    // A projector rebooting mid-service must not sit blank until the next line.
    const adapter = new BrowserAdapter('venue');
    adapter.show(line('l1', 'Already on screen.'));

    const late = fakeSocket();
    adapter.attach(late.socket);
    expect(JSON.parse(late.sent[0]!)).toMatchObject({
      type: 'show',
      line: { translation: 'Already on screen.' },
    });
  });

  it('sends nothing to a page that connects after a clear', () => {
    const adapter = new BrowserAdapter('venue');
    adapter.show(line('l1', 'Gone now.'));
    adapter.clear();

    const late = fakeSocket();
    adapter.attach(late.socket);
    expect(late.sent).toEqual([]);
  });

  it('stops tracking a socket once detached', () => {
    const adapter = new BrowserAdapter('venue');
    const socket = fakeSocket();
    const detach = adapter.attach(socket.socket);
    detach();
    adapter.show(line('l1', 'Nobody hears this.'));
    expect(socket.sent).toEqual([]);
    expect(adapter.connections).toBe(0);
  });

  it('drops a closed socket rather than throwing', () => {
    const adapter = new BrowserAdapter('venue');
    adapter.attach({ send: () => {}, open: false });
    adapter.show(line('l1', 'x'));
    expect(adapter.connections).toBe(0);
  });
});

describe('bridge server', () => {
  const PORT = 3199;
  const TOKEN = 'test-token';
  const venue = new BrowserAdapter('venue');
  let server: BridgeServer;

  beforeAll(async () => {
    server = new BridgeServer({
      host: '127.0.0.1',
      port: PORT,
      outputs: new Map([['venue', venue]]),
      token: TOKEN,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  const base = `http://127.0.0.1:${PORT}`;

  it('serves the overlay page', async () => {
    const response = await fetch(`${base}/overlay`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<!doctype html>');
  });

  it('serves the homepage at / rather than redirecting away from it', async () => {
    // The address somebody types on a tablet has to be the address that stays
    // in the bar, because that is the one that gets bookmarked — token and all.
    const response = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Caption bridge');
  });

  it('serves the homepage without a token, so a bad link explains itself', async () => {
    // Same rule as the overlay: never redirect to a login form. The page loads
    // and says the token is missing; the API behind it is what refuses.
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    expect(response.status).toBe(200);
  });

  it('serves the overlay without any login redirect', async () => {
    // §9: vMix's Browser input cannot type credentials. A redirect to a login
    // form would silently kill captions on air.
    const response = await fetch(`${base}/overlay`, { redirect: 'manual' });
    expect(response.status).toBe(200);
  });

  it('rejects a socket with the wrong token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=overlay&output=venue&token=wrong`);
    await expect(
      new Promise((resolvePromise, rejectPromise) => {
        ws.on('open', () => rejectPromise(new Error('should not have connected')));
        ws.on('error', () => resolvePromise('closed'));
        ws.on('close', () => resolvePromise('closed'));
      }),
    ).resolves.toBe('closed');
  });

  it('delivers a caption to a connected overlay', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${PORT}/ws?role=overlay&output=venue&token=${TOKEN}`,
    );
    await new Promise((r) => ws.on('open', r));

    const received = new Promise<string>((r) => ws.on('message', (data) => r(data.toString())));
    venue.show(line('l9', 'Live over the socket.'));

    expect(JSON.parse(await received)).toMatchObject({
      type: 'show',
      line: { translation: 'Live over the socket.' },
    });
    ws.close();
  });

});

describe('control endpoints', () => {
  const PORT = 3202;
  const TOKEN = 'control-token';
  const sessions: { action: string; device?: string | undefined }[] = [];
  let server: BridgeServer;
  let running = false;

  beforeAll(async () => {
    server = new BridgeServer({
      host: '127.0.0.1',
      port: PORT,
      outputs: new Map([['venue', new BrowserAdapter('venue')]]),
      token: TOKEN,
      listDevices: async () => [
        { name: 'CABLE Output (VB-Audio Virtual Cable)', likelyBus: true },
        { name: 'Microphone (Realtek(R) Audio)', likelyBus: false },
      ],
      onSession: (action, device) => {
        sessions.push({ action, device });
        running = action === 'start';
      },
      sessionStatus: () => ({ running, device: 'CABLE Output (VB-Audio Virtual Cable)', level: 0.2 }),
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  const base = `http://127.0.0.1:${PORT}`;

  it('refuses an unauthenticated call', async () => {
    // These do more than serve markup, so unlike the pages they are gated.
    expect((await fetch(`${base}/api/devices`)).status).toBe(401);
    expect((await fetch(`${base}/api/devices?token=wrong`)).status).toBe(401);
  });

  it('still serves the overlay page without a token, so vMix keeps working', async () => {
    expect((await fetch(`${base}/overlay`)).status).toBe(200);
  });

  it('lists devices with the likely bus flagged', async () => {
    const response = await fetch(`${base}/api/devices?token=${TOKEN}`);
    const body = (await response.json()) as { devices: { name: string; likelyBus: boolean }[] };
    expect(body.devices[0]).toEqual({
      name: 'CABLE Output (VB-Audio Virtual Cable)',
      likelyBus: true,
    });
  });

  it('starts and stops capture with the chosen device', async () => {
    const start = await fetch(`${base}/api/session?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', device: 'CABLE Output (VB-Audio Virtual Cable)' }),
    });
    expect(start.status).toBe(200);
    expect(sessions.at(-1)).toEqual({
      action: 'start',
      device: 'CABLE Output (VB-Audio Virtual Cable)',
    });
    expect((await start.json()) as { running: boolean }).toMatchObject({ running: true });

    await fetch(`${base}/api/session?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    expect(sessions.at(-1)?.action).toBe('stop');
  });

  it('rejects an action it does not recognise', async () => {
    const response = await fetch(`${base}/api/session?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reboot' }),
    });
    expect(response.status).toBe(400);
  });

  it('reports the level, so a dead cable is visible before the service starts', async () => {
    const response = await fetch(`${base}/api/session?token=${TOKEN}`);
    expect((await response.json()) as { level: number }).toMatchObject({ level: 0.2 });
  });
});



describe('app page contract', () => {
  const page = fileURLToPath(new URL('../public/app.html', import.meta.url));

  it('never stores anything in localStorage or sessionStorage (§8)', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/localStorage|sessionStorage/);
  });

  it('requests no external resources', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('warns against picking the main mix (INVARIANT 6)', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).toContain('not the main mix');
  });

  it('says what Stop does, since it does not discard the backlog', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).toContain('throw away the minutes still waiting');
  });

  it('says corrections go to the database, not to the .srt', async () => {
    // Hand-editing an .srt is silently overwritten by the next export; the page
    // has to make the direction of travel obvious.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('Corrections are saved to the database');
  });

});


describe('homepage contract', () => {
  const page = fileURLToPath(new URL('../public/home.html', import.meta.url));

  it('never stores anything in localStorage or sessionStorage (§8)', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/localStorage|sessionStorage/);
  });

  it('requests no external resources — the mandir LAN may have no route out', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('carries the token onward into every link it builds', async () => {
    // A homepage whose links drop the token is a homepage that sends whoever
    // opened it to four dead pages.
    const html = await readFile(page, 'utf8');
    expect(html).toContain("new URLSearchParams(location.search).get('token')");
    expect(html).toContain('function link(');
  });

  it('says that closing the page stops nothing', async () => {
    // The one thing somebody opening this from another PC needs to be sure of
    // before they shut the lid.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('Closing this page stops nothing');
  });

  it('offers no way to start or stop captions', async () => {
    // It is a signpost, opened on machines nobody is watching the level meter
    // on. Starting belongs on the Captions tab.
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/\/api\/session/);
  });

  it('reads its state from one endpoint, not four', async () => {
    // It polls forever on a spare screen; one round trip that degrades in
    // parts beats four that fail independently. The second fetch is the
    // one-off token bootstrap, which never repeats.
    const html = await readFile(page, 'utf8');
    const calls = html.match(/fetch\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(html).toContain("link('/api/home')");
    expect(html).toContain("fetch('/api/token'");
  });

  it('asks for a token when it was opened without one', async () => {
    // The front door cannot be locked by the thing it exists to hand out.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('function bootstrap()');
    expect(html).toContain("history.replaceState(null, '', '/?token='");
  });

  it('builds every link at render time, never before the token arrives', async () => {
    // A DESTINATIONS table of pre-built hrefs would capture the empty token and
    // send whoever opened it to six pages that 401.
    const html = await readFile(page, 'utf8');
    const table = html.slice(html.indexOf('var DESTINATIONS'), html.indexOf('function destinationCard'));
    expect(table).not.toMatch(/href:/);
    expect(table).toMatch(/path: '/);
  });
});

describe('overlay page contract', () => {
  const page = fileURLToPath(new URL('../public/overlay.html', import.meta.url));

  it('never stores anything in localStorage or sessionStorage (§8)', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/localStorage|sessionStorage/);
  });

  it('requests no external resources — it must render with no internet', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('keeps a transparent background so vMix can key it', async () => {
    expect(await readFile(page, 'utf8')).toMatch(/background:\s*transparent/);
  });
});

