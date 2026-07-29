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

  it('serves the overlay and reviewer pages', async () => {
    for (const path of ['/overlay', '/operator']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<!doctype html>');
    }
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

  it('passes operator commands through as advisory', async () => {
    const seen: unknown[] = [];
    const advisory = new BridgeServer({
      host: '127.0.0.1',
      port: PORT + 1,
      outputs: new Map(),
      onCommand: (command) => seen.push(command),
    });
    await advisory.start();

    const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws?role=operator`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'drop', lineId: 'l1' }));
    await new Promise((r) => setTimeout(r, 60));

    expect(seen).toContainEqual({ type: 'drop', lineId: 'l1' });
    ws.close();
    await advisory.stop();
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

describe('reviewer page contract', () => {
  const page = fileURLToPath(new URL('../public/operator.html', import.meta.url));

  it('never stores anything in localStorage or sessionStorage (§8)', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/localStorage|sessionStorage/);
  });

  it('requests no external resources', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('shows no jargon on screen (§7)', async () => {
    const html = await readFile(page, 'utf8');
    const body = html.slice(html.indexOf('<body'));
    const visible = body
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]+>/g, ' ');
    for (const word of ['WebSocket', 'RTT', 'socket', 'tokens/sec', 'latency', 'buffer']) {
      expect(visible).not.toContain(word);
    }
  });

  it('offers exactly one primary action', async () => {
    const html = await readFile(page, 'utf8');
    expect(html.match(/class="drop"/g)).toHaveLength(1);
    expect(html).toContain("Don't show this");
  });
});
