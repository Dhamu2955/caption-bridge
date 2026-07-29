/** Minimal stderr logger. Keeps stdout clean for anything a caller might pipe. */

let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function info(message: string): void {
  if (!quiet) process.stderr.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}
