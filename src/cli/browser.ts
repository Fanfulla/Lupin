// Best-effort browser open for the control API's OAuth login jobs. The
// printed URL is always the real path; this is only a convenience.

import { exec } from 'node:child_process';

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // best effort: the printed URL is the real path
  });
}
