import { serve } from '@hono/node-server';
import { watchFile } from 'node:fs';
import { defaultConfigPath, loadConfig } from '../config/config.js';
import { credentialStoreLabel } from '../config/credentials.js';
import { openBrowser } from '../cli/browser.js';
import { createApp } from './ingress.js';
import { createHealthTracker } from './health.js';
import { installKeepAlive } from './dispatcher.js';

installKeepAlive();

const configPath = defaultConfigPath();
// One tracker for the daemon's lifetime: health is short-term state and a
// RESTART is its sanctioned reset (ADR-25): a config reload is not.
const health = createHealthTracker();
const control = { openBrowser };
let config = loadConfig(configPath);
let app = createApp(config, { health, control });

// Hot reload (SPEC-CLI §1 `lupin use`): a polling watch, reliable across
// platforms and atomic tmp+rename replacements. A broken config never wins.
watchFile(configPath, { interval: 500 }, () => {
  try {
    const next = loadConfig(configPath);
    const prev = config.activeProfile;
    config = next;
    app = createApp(next, { health, control });
    console.log(
      next.activeProfile === prev
        ? '[lupin] config reloaded'
        : `[lupin] profile switched: ${prev} -> ${next.activeProfile}`,
    );
  } catch (e) {
    console.error(`[lupin] config reload failed, keeping previous: ${e instanceof Error ? e.message : String(e)}`);
  }
});

serve({ fetch: (req) => app.fetch(req), port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `[lupin] listening on http://127.0.0.1:${String(info.port)}: profile: ${config.activeProfile} (${configPath})`,
  );
  console.log(`[lupin] credentials: ${credentialStoreLabel()}`);
});
