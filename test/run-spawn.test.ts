// `lupin run` must deliver its arguments to the child byte for byte on every
// OS. Until 2026-07-29 the Windows spawn went through cmd.exe (`shell: true`):
// node joins the args into one command line with no quoting, so the inline
// --settings JSON of the startup announcement arrived mangled and claude
// refused to start ("Invalid JSON provided to --settings"). The fix (ADR-29):
// no shell for executables, and a settings FILE (never inline JSON) when the
// target is a .cmd/.bat shim, because batch files cannot be spawned without a
// shell (EINVAL since Node 20.12.2) and cmd.exe cannot carry inline JSON.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHead, shellSafeSettingsArgs } from '../src/cli/run.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lupin-run-spawn-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveHead: where the command really is, and whether a shell must carry it', () => {
  it('posix: the command goes to execvp untouched, never a shell', () => {
    expect(resolveHead('claude', 'linux', {})).toEqual({ command: 'claude', viaShell: false });
  });

  it('windows: a bare name is resolved through PATH + PATHEXT, an .exe needs no shell', () => {
    writeFileSync(join(dir, 'claude.exe'), '');
    const env = { PATH: dir, PATHEXT: '.com;.exe;.bat;.cmd' };
    expect(resolveHead('claude', 'win32', env)).toEqual({ command: join(dir, 'claude.exe'), viaShell: false });
  });

  it('windows: a .cmd shim cannot be spawned directly (EINVAL), it keeps cmd.exe', () => {
    writeFileSync(join(dir, 'claude.cmd'), '');
    const env = { PATH: dir, PATHEXT: '.com;.exe;.bat;.cmd' };
    expect(resolveHead('claude', 'win32', env)).toEqual({ command: join(dir, 'claude.cmd'), viaShell: true });
  });

  it('windows: PATHEXT order decides when several shims coexist', () => {
    writeFileSync(join(dir, 'claude.cmd'), '');
    writeFileSync(join(dir, 'claude.exe'), '');
    expect(resolveHead('claude', 'win32', { PATH: dir, PATHEXT: '.cmd;.exe' }).command).toBe(join(dir, 'claude.cmd'));
  });

  it('windows: a default PATHEXT applies when the env does not say', () => {
    writeFileSync(join(dir, 'claude.exe'), '');
    expect(resolveHead('claude', 'win32', { PATH: dir }).command).toBe(join(dir, 'claude.exe'));
  });

  it('windows: an explicit path is checked with PATHEXT too', () => {
    writeFileSync(join(dir, 'tool.cmd'), '');
    expect(resolveHead(join(dir, 'tool'), 'win32', {})).toEqual({ command: join(dir, 'tool.cmd'), viaShell: true });
  });

  it('windows: a name nobody has comes back untouched, so spawn fails like before', () => {
    expect(resolveHead('nobody-has-this', 'win32', { PATH: dir })).toEqual({
      command: 'nobody-has-this',
      viaShell: false,
    });
  });
});

describe('resolveHead: the CWD leg of the search, exactly as cmd defaults to it', () => {
  // The old `shell: true` spawn had cmd.exe searching the invocation directory
  // BEFORE PATH; dropping that leg silently broke a claude that only lives
  // there (audit 2026-07-29).
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
  });

  it('a shim only the current directory has is found, as an absolute path', () => {
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(resolveHead('claude', 'win32', { PATH: 'C:\\nowhere' })).toEqual({
      command: resolve('claude.cmd'),
      viaShell: true,
    });
  });

  it('the current directory wins over PATH, like cmd', () => {
    const onPath = mkdtempSync(join(tmpdir(), 'lupin-run-path-'));
    try {
      writeFileSync(join(dir, 'claude.cmd'), '');
      writeFileSync(join(onPath, 'claude.exe'), '');
      expect(resolveHead('claude', 'win32', { PATH: onPath }).command).toBe(resolve('claude.cmd'));
    } finally {
      rmSync(onPath, { recursive: true, force: true });
    }
  });

  it('NoDefaultCurrentDirectoryInExePath opts the CWD out, same as cmd', () => {
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(resolveHead('claude', 'win32', { PATH: 'C:\\nowhere', NoDefaultCurrentDirectoryInExePath: '1' })).toEqual({
      command: 'claude',
      viaShell: false,
    });
  });
});

describe('shellSafeSettingsArgs: settings for a target behind cmd.exe', () => {
  it('nothing to pass stays nothing, and no file appears', () => {
    const file = join(dir, 'run-announcement-1.json');
    expect(shellSafeSettingsArgs([], file)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('the inline JSON becomes a quoted file path, and the file holds exactly that JSON', () => {
    const json = JSON.stringify({ companyAnnouncements: ['Lupin: a b "c" 100% & <d>.'] });
    const file = join(dir, 'run-announcement-1.json');
    const args = shellSafeSettingsArgs(['--settings', json], file);
    expect(args).toEqual(['--settings', `"${file}"`]);
    expect(readFileSync(file, 'utf8')).toBe(json);
  });

  it('a directory that does not exist yet is created, not tripped over', () => {
    const file = join(dir, 'never-made', 'deeper', 'run-announcement-1.json');
    expect(shellSafeSettingsArgs(['--settings', '{}'], file)).toEqual(['--settings', `"${file}"`]);
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });

  it('an unwritable destination costs the announcement, never the session', () => {
    // The parent "directory" is a file: mkdirSync cannot succeed.
    writeFileSync(join(dir, 'blocker'), '');
    const file = join(dir, 'blocker', 'run-announcement-1.json');
    expect(shellSafeSettingsArgs(['--settings', '{}'], file)).toEqual([]);
  });
});

describe('the spawn itself, byte for byte (the 2026-07-29 regression)', () => {
  const json = JSON.stringify({ companyAnnouncements: ['Lupin: a b "c" 100% & <d>.'] });
  const echo = (file: string): void => {
    writeFileSync(file, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  };

  it('an executable gets the inline settings JSON intact, no shell in between', () => {
    const probe = join(dir, 'echo.js');
    echo(probe);
    // The same call shape runCommand uses for a direct (non-shell) target.
    const resolved = resolveHead(process.execPath);
    expect(resolved.viaShell).toBe(false);
    const res = spawnSync(resolved.command, [probe, '--settings', json], {
      encoding: 'utf8',
      shell: resolved.viaShell,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(JSON.stringify(['--settings', json]));
  });

  it.runIf(process.platform === 'win32')('a .cmd shim gets the settings file path intact through cmd.exe', () => {
    const echoJs = join(dir, 'echo.js');
    echo(echoJs);
    const shim = join(dir, 'probe.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echoJs}" %*\r\n`);
    // The same call shape runCommand uses for a batch (viaShell) target.
    const resolved = resolveHead(shim, 'win32', {});
    expect(resolved.viaShell).toBe(true);
    const file = join(dir, 'run-announcement-1.json');
    writeFileSync(file, json);
    const res = spawnSync(`"${resolved.command}"`, ['--settings', `"${file}"`], {
      encoding: 'utf8',
      shell: resolved.viaShell,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(JSON.stringify(['--settings', file]));
  });
});
