import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { BridgeServer, parseOperatorCommand } from '../src/live/server.js';
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

describe('control page contract', () => {
  const page = fileURLToPath(new URL('../public/control.html', import.meta.url));

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
});

describe('reviewer video contract', () => {
  const page = fileURLToPath(new URL('../public/operator.html', import.meta.url));

  it('takes the recording from the bridge rather than a path in the URL', async () => {
    // /api/media serves whatever the running session is playing and accepts no
    // path of its own, so there is nothing for a crafted URL to reach.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('message.media');
  });

  it('lets an explicit ?video= win', async () => {
    // Someone pointing at their own feed knows better than we do.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('!videoUrl && message.media');
  });

  it('maps caption time to file time with no offset to calibrate', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).toContain('Date.now() - state.sessionEpoch');
  });

  it('seeks from the words, never from the buttons', async () => {
    // A mis-tap must not drop a line that was about to go out.
    const html = await readFile(page, 'utf8');
    expect(html).toContain("gu.addEventListener('click'");
    expect(html).not.toMatch(/drop\.addEventListener\('click',\s*function\s*\(\)\s*\{\s*seekTo/);
  });

  it('starts muted, because a video with sound is not allowed to autoplay', async () => {
    // Unmuted, the browser refuses to play it at all and the picture sits
    // frozen with nothing saying why.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('el.video.muted = true');
  });

  it('turns sound on by a press, not by removing an attribute', async () => {
    // The muted content attribute only sets defaultMuted; removing it later
    // does nothing. The property is what mutes, and the press is the gesture
    // the autoplay policy is waiting for.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('el.video.muted = !el.video.muted');
    expect(html).not.toContain("removeAttribute('muted')");
  });

  it('still requests no external resources', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
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

  it('lets the framed reviewer play sound', async () => {
    // Without allow, "Sound on" works at /operator and silently does nothing
    // inside the tab.
    const html = await readFile(page, 'utf8');
    expect(html).toContain('allow="autoplay"');
  });

  it('runs the reviewer page itself rather than a second copy of it', async () => {
    // Two implementations of the queue would drift, and only one of them is
    // covered by the reviewer contract tests below.
    const html = await readFile(page, 'utf8');
    expect(html).toContain("'/operator'");
  });
});

describe('operator command parsing', () => {
  it('accepts the commands the reviewer page sends', () => {
    expect(parseOperatorCommand('{"type":"drop","lineId":"line-3"}')).toEqual({
      type: 'drop',
      lineId: 'line-3',
    });
    expect(parseOperatorCommand('{"type":"edit","lineId":"line-3","text":"Corrected."}')).toEqual({
      type: 'edit',
      lineId: 'line-3',
      text: 'Corrected.',
    });
    expect(parseOperatorCommand('{"type":"hold"}')).toEqual({ type: 'hold' });
  });

  it('ignores anything that is not a command this bridge knows', () => {
    // Nothing on this socket is trusted enough to guess at.
    expect(parseOperatorCommand('{"type":"shutdown"}')).toBeUndefined();
    expect(parseOperatorCommand('{"lineId":"line-3"}')).toBeUndefined();
    expect(parseOperatorCommand('not json')).toBeUndefined();
    expect(parseOperatorCommand('null')).toBeUndefined();
    expect(parseOperatorCommand('[1,2,3]')).toBeUndefined();
  });

  it('drops fields of the wrong type rather than passing them through', () => {
    expect(parseOperatorCommand('{"type":"edit","lineId":7,"text":{"a":1}}')).toEqual({
      type: 'edit',
    });
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

  it('offers exactly one primary action per line (§7)', async () => {
    const html = await readFile(page, 'utf8');
    // Cards are built in script now that the page shows a queue, so the class
    // is assigned rather than written in markup — but there is still exactly
    // one primary button, and it is the drop.
    expect(html.match(/className = 'drop'/g)).toHaveLength(1);
    expect(html).toContain("Don't show this");
  });

  it('keeps correcting a line secondary to dropping it', async () => {
    const html = await readFile(page, 'utf8');
    // A wrong line shown to nobody beats a hurried rewrite, so "fix" is a
    // ghost button beside the coloured one, never in place of it.
    expect(html).toMatch(/className = 'ghost fix'/);
    expect(html).toContain('Fix wording');
  });

  it('tells the reviewer when a line can no longer be changed (INVARIANT 10)', async () => {
    const html = await readFile(page, 'utf8');
    expect(html).toContain('Already went out');
  });

  it('shows at most one status note per line', async () => {
    const html = await readFile(page, 'utf8');
    // A line can be corrected AND past its air time at once. Showing "the new
    // wording goes out" beside "already went out" reads as a contradiction, so
    // the notes are driven by one attribute rather than three booleans.
    expect(html).toMatch(/data-note.*dropped.*expired.*edited/s);
    expect(html).not.toMatch(/card\[data-edited="true"\] \.note-edited/);
  });
});
