// `lupin resume [profile] [-- <claude args>]` (SPEC-CLI §1, DESIGN-HANDOFF §3.2):
// the scenario-B handoff as one gesture. The spawn itself is `lupin run`'s
// job, so the tests cover what is pure: when `--continue` is injected, when
// the user's own session flag wins, when the invocation is rejected BEFORE
// any state change, and what the cold-prefix advisory says and when.

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const useMock = vi.fn<(args: string[]) => number>();
const runMock = vi.fn<(args: string[]) => Promise<number>>();

vi.mock('../src/cli/use.js', () => ({ useCommand: (args: string[]) => useMock(args) }));
vi.mock('../src/cli/run.js', () => ({ runCommand: (args: string[]) => runMock(args) }));

const { resumeClaudeArgs, transcriptKey, transcriptAdvisory, resumeCommand } = await import('../src/cli/resume.js');

beforeEach(() => {
  useMock.mockReset().mockReturnValue(0);
  runMock.mockReset().mockResolvedValue(0);
});

describe('resumeClaudeArgs', () => {
  it('injects --continue when the user picked no session', () => {
    expect(resumeClaudeArgs([])).toEqual(['--continue']);
    expect(resumeClaudeArgs(['--verbose'])).toEqual(['--continue', '--verbose']);
  });

  it('injects nothing when the user picked their own session', () => {
    expect(resumeClaudeArgs(['--resume', 'abc'])).toEqual(['--resume', 'abc']);
    expect(resumeClaudeArgs(['--resume=abc'])).toEqual(['--resume=abc']);
    expect(resumeClaudeArgs(['--continue'])).toEqual(['--continue']);
    expect(resumeClaudeArgs(['-c'])).toEqual(['-c']);
    expect(resumeClaudeArgs(['-r', 'abc'])).toEqual(['-r', 'abc']);
    expect(resumeClaudeArgs(['--from-pr', '7'])).toEqual(['--from-pr', '7']);
  });
});

describe('transcriptKey', () => {
  it('matches the observed on-disk transform of a Windows cwd', () => {
    expect(transcriptKey('C:\\Users\\dev\\Desktop\\Lavoro\\Python\\Lupin')).toBe(
      'C--Users-dev-Desktop-Lavoro-Python-Lupin',
    );
  });

  it('maps a POSIX cwd the same way', () => {
    expect(transcriptKey('/home/dev/lupin')).toBe('-home-dev-lupin');
  });
});

describe('transcriptAdvisory', () => {
  function home(files: Record<string, number>, cwd: string): string {
    const h = mkdtempSync(join(tmpdir(), 'lupin-resume-'));
    const dir = join(h, '.claude', 'projects', transcriptKey(cwd));
    mkdirSync(dir, { recursive: true });
    for (const [name, size] of Object.entries(files)) {
      writeFileSync(join(dir, name), Buffer.alloc(size));
    }
    return h;
  }

  it('stays silent below the threshold', () => {
    const h = home({ 'a.jsonl': 1024 }, '/w');
    expect(transcriptAdvisory('/w', h)).toBeUndefined();
  });

  it('speaks past 1 MB, naming the size', () => {
    const h = home({ 'a.jsonl': 3 * 1024 * 1024 }, '/w');
    const line = transcriptAdvisory('/w', h);
    expect(line).toContain('3.0 MB');
    expect(line).toContain('cold');
  });

  it('measures the MOST RECENT transcript, not the biggest', () => {
    const h = home({}, '/w');
    const dir = join(h, '.claude', 'projects', transcriptKey('/w'));
    writeFileSync(join(dir, 'old.jsonl'), Buffer.alloc(5 * 1024 * 1024));
    const past = Date.now() / 1000 - 3600;
    utimesSync(join(dir, 'old.jsonl'), past, past);
    writeFileSync(join(dir, 'new.jsonl'), Buffer.alloc(1024));
    expect(transcriptAdvisory('/w', h)).toBeUndefined();
  });

  it('warns, without blocking, when the cwd never recorded a session', () => {
    // Observed live 2026-07-31: claude's own failure here is cryptic ("No
    // deferred tool marker found"), so the one-line warning is Lupin's job.
    const h = mkdtempSync(join(tmpdir(), 'lupin-resume-'));
    const line = transcriptAdvisory('/nowhere', h);
    expect(line).toContain('per-directory');
  });

  it('warns when the project directory exists but holds no transcript', () => {
    const h = home({ 'huge.txt': 4 * 1024 * 1024 }, '/w');
    expect(transcriptAdvisory('/w', h)).toContain('per-directory');
  });

  it('ignores files that are not transcripts when a transcript exists', () => {
    const h = home({ 'huge.txt': 4 * 1024 * 1024, 'a.jsonl': 10 }, '/w');
    expect(transcriptAdvisory('/w', h)).toBeUndefined();
  });
});

describe('lupin resume', () => {
  const quiet = (): string | undefined => undefined;

  it('switches the profile then relaunches claude --continue', async () => {
    const code = await resumeCommand(['kimi-sub'], quiet);
    expect(useMock).toHaveBeenCalledWith(['kimi-sub']);
    expect(runMock).toHaveBeenCalledWith(['--', 'claude', '--continue']);
    expect(code).toBe(0);
  });

  it('keeps the active profile when none is given', async () => {
    const code = await resumeCommand([], quiet);
    expect(useMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledWith(['--', 'claude', '--continue']);
    expect(code).toBe(0);
  });

  it('does not relaunch when the profile switch fails', async () => {
    useMock.mockReturnValue(1);
    const code = await resumeCommand(['nope'], quiet);
    expect(code).toBe(1);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects two positionals BEFORE any state change', async () => {
    const code = await resumeCommand(['a', 'b'], quiet);
    expect(code).toBe(1);
    expect(useMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects a flag where the profile goes: -h is not a profile, and claude flags need --', async () => {
    for (const args of [['-h'], ['--help'], ['--resume', 'abc']]) {
      const code = await resumeCommand(args, quiet);
      expect(code).toBe(1);
    }
    expect(useMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('lets a user-picked session replace the injected --continue', async () => {
    await resumeCommand(['kimi-sub', '--', '--resume', 'abc'], quiet);
    expect(runMock).toHaveBeenCalledWith(['--', 'claude', '--resume', 'abc']);
  });

  it('forwards extra claude args after the injected --continue', async () => {
    await resumeCommand(['--', '--verbose'], quiet);
    expect(runMock).toHaveBeenCalledWith(['--', 'claude', '--continue', '--verbose']);
  });

  it('prints the advisory before the relaunch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await resumeCommand([], () => 'big transcript warning');
      expect(log).toHaveBeenCalledWith('big transcript warning');
    } finally {
      log.mockRestore();
    }
  });
});
