// CLI simplification (DESIGN-OAUTH-PKCE-TUI §3): `lupin go` argument handling.
// The run itself spawns a process, so the tests cover the part that is pure:
// which profile is switched to and when the command is rejected.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// use and run are mocked so go's orchestration is tested without touching the
// filesystem or spawning a daemon.
const useMock = vi.fn<(args: string[]) => number>();
const runMock = vi.fn<(args: string[]) => Promise<number>>();

vi.mock('../src/cli/use.js', () => ({ useCommand: (args: string[]) => useMock(args) }));
vi.mock('../src/cli/run.js', () => ({ runCommand: (args: string[]) => runMock(args) }));

const { goCommand } = await import('../src/cli/go.js');

beforeEach(() => {
  useMock.mockReset().mockReturnValue(0);
  runMock.mockReset().mockResolvedValue(0);
});

describe('lupin go', () => {
  it('switches the profile then runs the command', async () => {
    const code = await goCommand(['kimi-sub', '--', 'claude']);
    expect(useMock).toHaveBeenCalledWith(['kimi-sub']);
    expect(runMock).toHaveBeenCalledWith(['--', 'claude']);
    expect(code).toBe(0);
  });

  it('runs without switching when no profile is given', async () => {
    const code = await goCommand(['--', 'claude']);
    expect(useMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledWith(['--', 'claude']);
    expect(code).toBe(0);
  });

  it('does not run when the profile switch fails', async () => {
    useMock.mockReturnValue(1);
    const code = await goCommand(['nope', '--', 'claude']);
    expect(code).toBe(1);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('refuses a missing command', async () => {
    const code = await goCommand(['kimi-sub']);
    expect(code).toBe(1);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('forwards command arguments after the separator', async () => {
    await goCommand(['--', 'claude', '-p', 'hello']);
    expect(runMock).toHaveBeenCalledWith(['--', 'claude', '-p', 'hello']);
  });
});
