// `lupin update` (SPEC-CLI §1, ADR-49): the decision is a pure function of the
// observed state; these tests pin it, plus the registry read and the PATH
// search the executor feeds it with.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compareVersions,
  fetchLatestVersion,
  findOnPath,
  installPackageWithLifecycle,
  npmInvocation,
  parseVersion,
  planUpdate,
  REGISTRY_LATEST_URL,
} from '../src/cli/update.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-update-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('version comparison', () => {
  it('parses x.y.z and nothing fancier', () => {
    expect(parseVersion('0.2.1')).toEqual([0, 2, 1]);
    expect(parseVersion(' 1.10.3 ')).toEqual([1, 10, 3]);
    for (const bad of ['0.2', '0.2.1-rc.1', 'v0.2.1', 'latest', '']) {
      expect(parseVersion(bad), bad).toBeUndefined();
    }
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.2.1', '0.10.0')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.2.1', '0.3.0-rc.1')).toBeUndefined();
  });
});

describe('planUpdate (ADR-49)', () => {
  it('latest or newer than the registry means nothing to do', () => {
    const idle = { kind: 'upToDate', rebuildSidecar: false, sidecarHint: false };
    expect(planUpdate({ current: '0.2.1', latest: '0.2.1', cargoAvailable: true })).toEqual(idle);
    expect(planUpdate({ current: '0.3.0', latest: '0.2.1', cargoAvailable: true })).toEqual(idle);
    expect(
      planUpdate({
        current: '0.3.0',
        latest: '0.2.1',
        sidecarPath: '/bin/lupin-tui',
        sidecarVersion: '0.3.0',
        cargoAvailable: true,
      }),
    ).toEqual(idle);
  });

  it('a stale sidecar is rebuilt even when the package is already latest', () => {
    // The bootstrap case: `npm i -g` from a version predating `lupin update`
    // leaves the sidecar behind, and the next `lupin update` must fix it.
    const base = { current: '0.2.2', latest: '0.2.2', sidecarPath: '/bin/lupin-tui' };
    expect(planUpdate({ ...base, sidecarVersion: '0.1.1', cargoAvailable: true })).toEqual({
      kind: 'upToDate',
      rebuildSidecar: true,
      sidecarHint: false,
    });
    expect(planUpdate({ ...base, sidecarVersion: '0.1.1', cargoAvailable: false })).toEqual({
      kind: 'upToDate',
      rebuildSidecar: false,
      sidecarHint: true,
    });
    // A matching sidecar, or one whose version cannot be read, is left alone:
    // a guess could rebuild a healthy binary forever.
    expect(planUpdate({ ...base, sidecarVersion: '0.2.2', cargoAvailable: true })).toMatchObject({
      rebuildSidecar: false,
      sidecarHint: false,
    });
    expect(planUpdate({ ...base, cargoAvailable: true })).toMatchObject({ rebuildSidecar: false });
  });

  it('an unparsable version decides nothing rather than guessing', () => {
    expect(planUpdate({ current: '0.2.1', latest: 'nightly', cargoAvailable: true })).toEqual({ kind: 'incomparable' });
  });

  it('the sidecar is rebuilt only when the user built one AND cargo exists', () => {
    const base = { current: '0.2.1', latest: '0.2.2' };
    expect(planUpdate({ ...base, cargoAvailable: true })).toEqual({
      kind: 'update',
      rebuildSidecar: false,
      sidecarHint: false,
    });
    expect(planUpdate({ ...base, sidecarPath: '/bin/lupin-tui', cargoAvailable: true })).toEqual({
      kind: 'update',
      rebuildSidecar: true,
      sidecarHint: false,
    });
    expect(planUpdate({ ...base, sidecarPath: '/bin/lupin-tui', cargoAvailable: false })).toEqual({
      kind: 'update',
      rebuildSidecar: false,
      sidecarHint: true,
    });
  });
});

describe('fetchLatestVersion', () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    ((url: string | URL | Request) => {
      expect(String(url)).toBe(REGISTRY_LATEST_URL);
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof fetch;

  it('reads the latest dist-tag version', async () => {
    await expect(fetchLatestVersion(respond(200, { version: '0.2.2' }))).resolves.toBe('0.2.2');
  });

  it('a non-200 or a shapeless answer is an error, never a guess', async () => {
    await expect(fetchLatestVersion(respond(500, {}))).rejects.toThrow(/HTTP 500/);
    await expect(fetchLatestVersion(respond(200, { name: 'lupin-code' }))).rejects.toThrow(/no version/);
  });
});

describe('findOnPath', () => {
  it('finds a binary in a PATH directory, per-platform extensions included', () => {
    writeFileSync(join(dir, 'sometool'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'wintool.exe'), 'MZ');
    const env = { PATH: dir, PATHEXT: '.com;.exe' };
    expect(findOnPath('sometool', env, 'linux')).toBe(join(dir, 'sometool'));
    expect(findOnPath('wintool', env, 'win32')).toBe(join(dir, 'wintool.exe'));
    expect(findOnPath('missing', env, 'linux')).toBeUndefined();
  });

  it('an empty PATH finds nothing rather than throwing', () => {
    expect(findOnPath('anything', {}, 'linux')).toBeUndefined();
  });
});

describe('global package replacement on Windows', () => {
  it('uses the npm bundled with Node instead of a shadowed global npm shim', () => {
    expect(
      npmInvocation('win32', 'C:\\Program Files\\nodejs\\node.exe', (path) =>
        path.endsWith('node_modules\\npm\\bin\\npm-cli.js'),
      ),
    ).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      argsPrefix: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
      shell: false,
    });
  });

  it('quiesces Lupin before npm and restores a previously running daemon afterwards', async () => {
    const events: string[] = [];
    const result = await installPackageWithLifecycle({
      quiesce: async () => {
        events.push('quiesce');
        return {
          daemonWasRunning: true,
          release: () => events.push('release'),
        };
      },
      install: () => {
        events.push('npm-install');
        return 0;
      },
      restart: async () => {
        events.push('restart');
      },
    });

    expect(events).toEqual(['quiesce', 'npm-install', 'restart', 'release']);
    expect(result).toEqual({ installStatus: 0 });
  });

  it('restores a previously running daemon even when npm fails', async () => {
    const events: string[] = [];
    const result = await installPackageWithLifecycle({
      quiesce: async () => ({
        daemonWasRunning: true,
        release: () => events.push('release'),
      }),
      install: () => {
        events.push('npm-failed');
        return 1;
      },
      restart: async () => {
        events.push('restart');
      },
    });

    expect(events).toEqual(['npm-failed', 'restart', 'release']);
    expect(result).toEqual({ installStatus: 1 });
  });
});
