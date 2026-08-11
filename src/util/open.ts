import { spawn } from 'node:child_process';

/**
 * Open a URL in whatever browser this machine considers its default.
 *
 * Detached and unref'd, and that is the entire point of the file: the browser
 * must not be a child this process waits on, and closing the page — or closing
 * the whole browser — must not so much as reach the bridge. A service is being
 * captioned from this process; the tab that launched it is incidental.
 *
 * Best effort. A headless machine, a locked-down desktop or no handler at all
 * are all fine — the URL was printed a line earlier either way.
 */
/** Split out so the per-platform incantations are testable without spawning. */
export function launchCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  // The empty "" is the window title `start` swallows when it is missing,
  // which would otherwise eat the URL itself.
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

export function openInBrowser(url: string, platform = process.platform): boolean {
  const [command, args] = launchCommand(platform, url);

  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    // A missing handler arrives as an async error; swallow it rather than
    // taking the process down over a convenience.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
