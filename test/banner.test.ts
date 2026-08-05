import { describe, expect, it } from 'vitest';
import { banner, bannerLine } from '../src/cli/banner.js';
import { CLIENT_VERSION } from '../src/providers/identity.js';

describe('banner (CLI wordmark)', () => {
  it('is a rectangle: every wordmark row has the same width', () => {
    const rows = banner('1.2.3').split('\n').slice(0, 6);
    const widths = new Set(rows.map((r) => [...r].length));
    expect(widths.size).toBe(1);
  });

  it('carries the version it was given, and the real one by default', () => {
    expect(banner('1.2.3')).toContain('v1.2.3');
    expect(banner()).toContain(`v${CLIENT_VERSION}`);
    expect(bannerLine('1.2.3')).toContain('LUPIN v1.2.3');
  });

  it('stays plain text: no ANSI escapes, no tabs, so a redirected stdout is clean', () => {
    const out = banner();
    expect(out.includes('')).toBe(false);
    expect(out.includes('\t')).toBe(false);
  });
});
