import { serve } from '@hono/node-server';
import { existsSync, watchFile } from 'node:fs';
import { defaultConfigPath, loadConfig } from '../config/config.js';
import { credentialStoreLabel } from '../config/credentials.js';
import { openBrowser } from '../cli/browser.js';
import { createDaemonConfigLifecycle, fetchWithDaemonConfigLifecycle, initialDaemonConfig } from './daemon.js';
import { createApp } from './ingress.js';
import { createHealthTracker } from './health.js';
import { installKeepAlive } from './dispatcher.js';

installKeepAlive();

const configPath = defaultConfigPath();
// One tracker for the daemon's lifetime: health is short-term state and a
// RESTART is its sanctioned reset (ADR-25): a config reload is not.
const health = createHealthTracker();
const control = { openBrowser };
const initial = initialDaemonConfig(configPath);
const lifecycle = createDaemonConfigLifecycle(initial);
let config = lifecycle.current();
let app = createApp(config, { health, control });

// Hot reload (SPEC-CLI §1 `lupin use`): a polling watch, reliable across
// platforms and atomic tmp+rename replacements. A broken config never wins.
function reloadConfig(): void {
  try {
    const next = loadConfig(configPath);
    const prev = config.activeProfile;
    lifecycle.adopt(next);
    config = lifecycle.current();
    app = createApp(next, { health, control });
    console.log(
      next.activeProfile === prev
        ? '[lupin] config reloaded'
        : `[lupin] profile switched: ${prev} -> ${next.activeProfile}`,
    );
  } catch (e) {
    console.error(`[lupin] config reload failed, keeping previous: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function watchConfig(): void {
  watchFile(configPath, { interval: 500 }, reloadConfig);
}

if (initial.bootstrap) {
  const waitForConfig = setInterval(() => {
    if (!existsSync(configPath)) return;
    clearInterval(waitForConfig);
    reloadConfig();
    watchConfig();
  }, 500);
  waitForConfig.unref();
} else {
  watchConfig();
}

serve(
  {
    fetch: (req) => fetchWithDaemonConfigLifecycle(req, lifecycle, (request) => app.fetch(request)),
    port: config.port,
    hostname: '127.0.0.1',
  },
  (info) => {
  console.log(
    `[lupin] listening on http://127.0.0.1:${String(info.port)}: profile: ${config.activeProfile} (${configPath})`,
  );
  console.log(`[lupin] credentials: ${credentialStoreLabel()}`);
  },
);
