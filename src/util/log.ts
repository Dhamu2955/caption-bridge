/** Minimal stderr logger. Keeps stdout clean for anything a caller might pipe. */

import { AsyncLocalStorage } from 'node:async_hooks';

let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, message: string) => void;

/**
 * A second destination for log lines, scoped to one async call tree.
 *
 * The commands report progress by calling `info()`. A web UI needs those lines
 * too, but rewriting six commands to thread a callback through would be a lot
 * of churn for something they already do. `AsyncLocalStorage` propagates
 * through awaits, timers and child-process callbacks, so wrapping a command in
 * `runWithSink` captures its output wherever it happens.
 *
 * Scoped rather than a module-level sink on purpose: two jobs running at once
 * would otherwise write into each other's logs. Outside a `runWithSink` there
 * is no store, so the CLI is byte-for-byte unchanged.
 */
const sinks = new AsyncLocalStorage<LogSink>();

export function runWithSink<T>(sink: LogSink, fn: () => T): T {
  return sinks.run(sink, fn);
}

function emit(level: LogLevel, message: string): void {
  const sink = sinks.getStore();
  if (!sink) return;
  // A sink that throws must never take down the command it is observing.
  try {
    sink(level, message);
  } catch {
    /* ignore */
  }
}

export function info(message: string): void {
  if (!quiet) process.stderr.write(`${message}\n`);
  emit('info', message);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
  emit('warn', message);
}

export function fail(message: string): void {
  process.stderr.write(`error: ${message}\n`);
  emit('error', message);
}
