// `lupin status` / `stop` / `logs [-f]` (SPEC-CLI §1).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadConfig } from '../config/config.js';
import { credentialStoreLabel } from '../config/credentials.js';
import { logfilePath, readPidfile, serverAlive, stopDaemon } from '../server/daemon.js';

export async function statusCommand(): Promise<number> {
  let port = 3456;
  let profile = '?';
  try {
    const config = loadConfig();
    port = config.port;
    profile = config.activeProfile;
  } catch {
    // no config yet: still report daemon state on the default port
  }
  const alive = await serverAlive(port);
  const pid = readPidfile();
  if (alive) {
    console.log(
      `running on http://127.0.0.1:${String(port)}${pid !== undefined ? ` (pid ${String(pid)})` : ''}, active profile: ${profile}`,
    );
  } else {
    console.log('not running');
  }
  console.log(`credentials: ${credentialStoreLabel()}`);
  return 0;
}

export function stopCommand(): number {
  const result = stopDaemon();
  console.log(result === 'stopped' ? '✓ daemon stopped' : 'daemon was not running');
  return 0;
}

export async function logsCommand(args: string[]): Promise<number> {
  const follow = args.includes('-f');
  const path = logfilePath();
  if (!existsSync(path)) {
    console.log('(no logs yet)');
    return 0;
  }
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').filter((l) => l !== '');
  for (const line of lines.slice(-20)) console.log(line);
  if (!follow) return 0;

  let offset = statSync(path).size;
  // -f: poll for appended bytes until Ctrl+C
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const size = statSync(path).size;
    if (size > offset) {
      // Byte offsets slice bytes: slicing the DECODED string with a byte
      // offset drifts as soon as a line carries anything multibyte
      // (audit 2026-07-29).
      const buf = readFileSync(path);
      process.stdout.write(buf.subarray(offset, size).toString('utf8'));
      offset = size;
    } else if (size < offset) {
      offset = size; // truncated/rotated
    }
  }
}
