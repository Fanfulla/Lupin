// Who Lupin says it is to a provider (SPEC-PROVIDERS §5bis). Declarative data,
// used both by the OAuth device flow (console device name) and by the
// per-request attribution headers. Honest attribution: Lupin never presents
// itself as one of the official CLIs.

import { readFileSync } from 'node:fs';

// Single source of truth for the version: package.json, read at module load.
// Works from src (../../package.json = repo root) and from dist (= pkg root)
// alike; a hand-copied constant here drifted silently (audit §7.2).
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const CLIENT_NAME = 'Lupin-porting-CC';
export const CLIENT_VERSION = pkg.version;
export const CLIENT_URL = 'https://github.com/Fanfulla/Lupin';
