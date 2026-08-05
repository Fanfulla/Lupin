// `lupin run` greets the session with the routing truth. Claude Code's welcome
// box cannot be changed, but it does render `companyAnnouncements`, and
// `--settings` takes inline JSON that overrides only that key for this session,
// so nothing of the user's is written (ADR-11 holds).

import { describe, expect, it } from 'vitest';
import { announcementArgs, startupAnnouncement } from '../src/cli/run.js';

const yes = (): boolean => true;
const no = (): boolean => false;

describe('what the announcement says', () => {
  it('names the profile and the model that will answer', () => {
    expect(startupAnnouncement({ activeProfile: 'kimi-sub', slots: { sonnet: 'kimi-k2.5' } })).toBe(
      'Lupin: this session runs on kimi-sub → kimi-k2.5.',
    );
  });

  // The default model of Claude Code (claude-fable-5) lands on the OPUS slot,
  // so a profile whose slots differ must be announced with the opus one.
  it('announces the opus slot, the one the default model resolves to', () => {
    expect(
      startupAnnouncement({ activeProfile: 'p', slots: { opus: 'kimi-k3', sonnet: 'kimi-k2.5', haiku: 'kimi-lite' } }),
    ).toBe('Lupin: this session runs on p → kimi-k3.');
  });

  it('falls back down the slots when the opus delegation is broken', () => {
    expect(startupAnnouncement({ activeProfile: 'p', slots: { haiku: 'only-one' } })).toBe(
      'Lupin: this session runs on p → only-one.',
    );
  });

  it('says free tier, and where the paid plan is', () => {
    const line = startupAnnouncement({
      activeProfile: 'gemini-sub',
      slots: { sonnet: 'gemini-2.5-flash' },
      tier: { free: true, upgrade: 'https://example.invalid/upgrade' },
    });
    expect(line).toContain('FREE tier');
    expect(line).toContain('gemini-2.5-flash');
    expect(line).toContain('https://example.invalid/upgrade');
  });

  it('never claims a free tier the daemon does not know about', () => {
    const line = startupAnnouncement({ activeProfile: 'p', slots: { sonnet: 'm' } });
    expect(line).not.toContain('FREE');
  });

  it('an unreachable daemon says nothing at all', () => {
    expect(startupAnnouncement({})).toBeUndefined();
  });
});

describe('when the flag is actually passed', () => {
  const line = 'Lupin: this session runs on p.';

  it('claude, flag supported → inline JSON with the announcement', () => {
    const args = announcementArgs('claude', [], line, yes);
    expect(args[0]).toBe('--settings');
    expect(JSON.parse(args[1] ?? '{}')).toEqual({ companyAnnouncements: [line] });
  });

  it('the .cmd shim on Windows is still claude', () => {
    expect(announcementArgs('C:\\bin\\claude.cmd', [], line, yes)).toHaveLength(2);
  });

  it('any other command is left completely alone', () => {
    expect(announcementArgs('npm', ['test'], line, yes)).toEqual([]);
  });

  it('an older Claude Code that lacks the flag gets nothing: a broken start is worse', () => {
    expect(announcementArgs('claude', [], line, no)).toEqual([]);
  });

  it("the user's own --settings always wins", () => {
    expect(announcementArgs('claude', ['--settings', './mine.json'], line, yes)).toEqual([]);
    expect(announcementArgs('claude', ['--settings=./mine.json'], line, yes)).toEqual([]);
  });

  it('nothing to say → no flag', () => {
    expect(announcementArgs('claude', [], undefined, yes)).toEqual([]);
  });
});
