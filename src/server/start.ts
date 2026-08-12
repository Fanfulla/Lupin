import { serve } from '@hono/node-server';
import { existsSync, watchFile } from 'node:fs';
import { defaultConfigPath, loadConfig } from '../config/config.js';
import { credentialStoreLabel } from '../config/credentials.js';
import { openBrowser } from '../cli/browser.js';
import {
  createDaemonConfigLifecycle,
  fetchWithDaemonConfigLifecycle,
  initialDaemonConfig,
  observeBootstrapConfigBeforeReload,
} from './daemon.js';
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
function loadAndApplyConfig(): void {
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
}

function reloadConfig(): void {
  try {
    loadAndApplyConfig();
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
    observeBootstrapConfigBeforeReload(watchConfig, reloadConfig);
  }, 500);
  waitForConfig.unref();
} else {
  watchConfig();
}

// The watchdog holds this port while the daemon is down and yields it only
// when its 300ms poll sees a LIVE pid in the pidfile (§6.4). The pidfile is
// written by the parent at spawn, but on a fast machine this process reaches
// its own bind first, died on EADDRINUSE, and the yield never happened: a
// stop followed by a start inside the watchdog hold could not come up at all
// (found live 2026-08-12, WSL). Retrying inside a bounded window closes the
// race in both directions; a port genuinely owned by something else still
// fails, with the honest error, once the window runs out.
const BIND_RETRY_WINDOW_MS = 10_000;
const BIND_RETRY_DELAY_MS = 250;

function startServer(deadline: number = Date.now() + BIND_RETRY_WINDOW_MS): void {
  const server = serve(
    {
      fetch: (req) =>
        fetchWithDaemonConfigLifecycle(req, lifecycle, (request) => app.fetch(request), () => {
          if (existsSync(configPath)) loadAndApplyConfig();
        }),
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
  server.on('error', (e: unknown) => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' && Date.now() < deadline) {
      setTimeout(() => {
        server.close(() => startServer(deadline));
      }, BIND_RETRY_DELAY_MS);
      return;
    }
    console.error(`[lupin] cannot bind 127.0.0.1:${String(config.port)}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

startServer();
