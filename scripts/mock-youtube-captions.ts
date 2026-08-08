import { createServer } from 'node:http';

/**
 * A stand-in for YouTube's caption ingestion endpoint.
 *
 * YouTube only hands out a real ingestion URL once a stream is live, and live
 * privileges take a day to be granted — so without this there is no way to see
 * what the bridge would actually send until the moment it matters. This accepts
 * the POSTs and prints them, which is enough to check the things that are
 * genuinely easy to get wrong: that the timestamps advance with the audio, that
 * the sequence numbers have no gaps, and above all that a line the reviewer
 * dropped never arrives.
 *
 * It is not a substitute for calibrating against a real stream. The wire format
 * is the one part of this path that cannot be verified from the code.
 *
 *   npx tsx scripts/mock-youtube-captions.ts
 *   → paste the printed URL into Settings → YouTube caption URL
 *
 * Options:
 *   --port <n>   default 4000
 *   --fail <n>   reject one POST in every n, to exercise the error path
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const port = Number(flag('port') ?? 4000);
const failEvery = Number(flag('fail') ?? 0);

interface Received {
  at: number;
  seq: number | undefined;
  timestamp: string;
  text: string;
}

const received: Received[] = [];
let posts = 0;

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('POST only\n');
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    posts++;

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const seqRaw = url.searchParams.get('seq');
    const seq = seqRaw === null ? undefined : Number(seqRaw);

    // The wire format the adapter writes: a timestamp line, then the caption.
    const lines = body.split('\n');
    const timestamp = lines[0] ?? '';
    const text = lines.slice(1).join('\n').trimEnd();

    if (failEvery > 0 && posts % failEvery === 0) {
      // A rejected POST must not consume a sequence number — the next one
      // should arrive with this same number rather than the one after it.
      process.stdout.write(`  ✗ seq=${seq}  REJECTED (503, on purpose)\n`);
      res.writeHead(503).end('nope\n');
      return;
    }

    const previous = received[received.length - 1];
    const gap = previous && seq !== undefined && previous.seq !== undefined && seq !== previous.seq + 1;

    received.push({ at: Date.now(), seq, timestamp, text });

    process.stdout.write(
      `  ✓ seq=${String(seq).padEnd(4)} ${timestamp}  ${text}\n` +
        (gap ? `    ⚠ sequence jumped from ${previous?.seq} to ${seq}\n` : ''),
    );

    res.writeHead(200).end('ok\n');
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `\nPretending to be YouTube on port ${port}.\n\n` +
      `  Paste this into Settings → YouTube caption URL:\n\n` +
      `    http://127.0.0.1:${port}/closedcaption?cid=mock\n\n` +
      (failEvery > 0 ? `  Rejecting one POST in every ${failEvery}.\n\n` : '') +
      `Captions will be listed below as they arrive. Ctrl+C to stop.\n\n`,
  );
});

process.on('SIGINT', () => {
  const seqs = received.map((entry) => entry.seq).filter((n): n is number => n !== undefined);
  const expected = seqs.length > 0 ? seqs[seqs.length - 1]! - seqs[0]! + 1 : 0;

  process.stdout.write(
    `\n\n${received.length} captions received, ${posts} POSTs.\n` +
      (seqs.length > 0
        ? `Sequence ${seqs[0]}–${seqs[seqs.length - 1]}` +
          (expected === seqs.length ? ' with no gaps.\n' : ` but only ${seqs.length} arrived — there is a gap.\n`)
        : '') +
      `\nWhat to check: every line you did NOT drop is above, and every line you\n` +
      `did drop is not.\n\n`,
  );
  server.close(() => process.exit(0));
});
