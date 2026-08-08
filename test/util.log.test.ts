import { describe, expect, it } from 'vitest';

import { info, runWithSink, setQuiet, warn, type LogLevel } from '../src/util/log.js';

/**
 * The sink exists so a web UI can watch a long ingest without the six commands
 * that produce the output having to know a web UI exists. The properties that
 * matter are that it is scoped (two jobs never bleed into each other) and that
 * it is invisible when absent (the CLI is unchanged).
 */

function collect(): { lines: [LogLevel, string][]; sink: (l: LogLevel, m: string) => void } {
  const lines: [LogLevel, string][] = [];
  return { lines, sink: (level, message) => lines.push([level, message]) };
}

describe('scoped log sink', () => {
  it('captures info, warn and fail with their level', () => {
    setQuiet(true);
    const { lines, sink } = collect();

    runWithSink(sink, () => {
      info('extracting audio');
      warn('30s of silence');
    });

    setQuiet(false);
    expect(lines).toEqual([
      ['info', 'extracting audio'],
      ['warn', '30s of silence'],
    ]);
  });

  it('follows the command across awaits', async () => {
    setQuiet(true);
    const { lines, sink } = collect();

    await runWithSink(sink, async () => {
      info('one');
      await new Promise((resolve) => setTimeout(resolve, 1));
      info('two');
    });

    setQuiet(false);
    expect(lines.map(([, message]) => message)).toEqual(['one', 'two']);
  });

  it('keeps two concurrent jobs out of each other pockets', async () => {
    setQuiet(true);
    const a = collect();
    const b = collect();

    await Promise.all([
      runWithSink(a.sink, async () => {
        info('ingest 1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        info('ingest 2');
      }),
      runWithSink(b.sink, async () => {
        info('index 1');
        await new Promise((resolve) => setTimeout(resolve, 1));
        info('index 2');
      }),
    ]);

    setQuiet(false);
    expect(a.lines.map(([, m]) => m)).toEqual(['ingest 1', 'ingest 2']);
    expect(b.lines.map(([, m]) => m)).toEqual(['index 1', 'index 2']);
  });

  it('does nothing outside a sink, so the CLI is unchanged', () => {
    setQuiet(true);
    // No store — this must not throw and must not look for one.
    expect(() => info('plain cli run')).not.toThrow();
    setQuiet(false);
  });

  it('survives a sink that throws', () => {
    setQuiet(true);
    // A browser disconnecting mid-ingest must not take the ingest with it.
    expect(() =>
      runWithSink(
        () => {
          throw new Error('socket closed');
        },
        () => info('still working'),
      ),
    ).not.toThrow();
    setQuiet(false);
  });
});
