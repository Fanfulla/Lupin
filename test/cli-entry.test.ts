import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { CLIENT_VERSION } from '../src/providers/identity.js';

// The entry dispatch had no test at all, and that is how `lupin --version`
// managed to answer "unknown command" all the way to a packed 0.1.0 tarball,
// while SECURITY.md was asking bug reports to include its output.

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.join(' ')));
  return {
    out,
    err,
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lupin entry dispatch', () => {
  for (const flag of ['--version', '-v', 'version']) {
    it(`${flag} prints the bare version on stdout and exits 0`, async () => {
      const cap = capture();
      const code = await main([flag]);
      cap.restore();
      expect(code).toBe(0);
      // Bare on purpose: a script greps this, and a banner around it would make
      // every such script parse prose.
      expect(cap.out).toEqual([CLIENT_VERSION]);
      expect(cap.err).toEqual([]);
    });
  }

  for (const flag of ['--help', '-h', 'help']) {
    it(`${flag} prints the usage and exits 0`, async () => {
      const cap = capture();
      const code = await main([flag]);
      cap.restore();
      expect(code).toBe(0);
      expect(cap.out.join('\n')).toContain('lupin: Claude Code with any LLM provider');
    });
  }

  it('the usage names the slot flags, so it cannot drift from the command again', async () => {
    const cap = capture();
    await main(['--help']);
    cap.restore();
    const usage = cap.out.join('\n');
    for (const flag of ['--opus', '--sonnet', '--haiku', '--bg']) expect(usage).toContain(flag);
  });

  it('an unknown command fails with the usage on stderr', async () => {
    const cap = capture();
    const code = await main(['nope']);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toContain('unknown command: nope');
  });
});
