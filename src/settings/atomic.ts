import { copyFile, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write a file without ever leaving a half-written one behind.
 *
 * These files hold the operator's credentials and the settings the bridge boots
 * from. A truncated `.env` after a power cut on a Sunday morning is a much
 * worse failure than a write that did not happen, so every write goes to a
 * temp file, is flushed to disk, and is then renamed over the target — a rename
 * within a directory is atomic, so a reader sees either the old file or the
 * new one and never a partial.
 */

export interface AtomicWriteOptions {
  /** Only applied when the file does not already exist; otherwise preserved. */
  mode?: number;
  /** Copy the previous contents to `<path>.bak` first. */
  backup?: boolean;
}

/**
 * One write at a time per path. Two concurrent saves of the same file would
 * otherwise race on the backup step and could leave `.bak` matching neither
 * version.
 */
const inFlight = new Map<string, Promise<void>>();

async function write(path: string, contents: string, options: AtomicWriteOptions): Promise<void> {
  const directory = dirname(path);

  // The temp file must sit in the SAME directory as the target. A temp in the
  // system tmpdir is usually on a different filesystem, where rename fails with
  // EXDEV and the atomicity is lost.
  const temporary = join(directory, `.${randomBytes(6).toString('hex')}.tmp`);

  let mode = options.mode;
  let exists = false;
  try {
    const existing = await stat(path);
    exists = true;
    mode = existing.mode & 0o777;
  } catch {
    /* new file — keep the requested mode */
  }

  if (options.backup && exists) {
    await copyFile(path, `${path}.bak`);
  }

  try {
    const handle = await open(temporary, 'w', mode);
    try {
      await handle.writeFile(contents, 'utf8');
      // Without this the rename can land before the bytes do, which is exactly
      // the truncated-credentials case this function exists to prevent.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (err) {
    await unlink(temporary).catch(() => {});
    throw err;
  }
}

export async function writeFileAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const previous = inFlight.get(path) ?? Promise.resolve();
  // Chain off the previous write's settlement, not its success — one failure
  // must not wedge every later write to the same path.
  const next = previous.catch(() => {}).then(() => write(path, contents, options));
  inFlight.set(path, next);
  try {
    await next;
  } finally {
    if (inFlight.get(path) === next) inFlight.delete(path);
  }
}
