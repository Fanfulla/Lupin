// Recommended-skills offer (user decision 2026-07-29): the decision logic,
// with the IO injected so no terminal and no `claude` process is needed.

import { describe, expect, it } from 'vitest';
import { runSkillOffer, RECOMMENDED_SKILLS, type RecommendedSkill } from '../src/cli/skills-offer.js';

const two: RecommendedSkill[] = [
  { label: 'one', description: 'd1', marketplace: 'a/one', plugin: 'one@one' },
  { label: 'two', description: 'd2', marketplace: 'b/two', plugin: 'two@two' },
];

function ioWith(answers: string[], runOk = true) {
  const calls: string[][] = [];
  const printed: string[] = [];
  let i = 0;
  return {
    calls,
    printed,
    io: {
      ask: () => Promise.resolve(answers[i++] ?? ''),
      run: (args: string[]) => {
        calls.push(args);
        return Promise.resolve(runOk);
      },
      print: (l: string) => printed.push(l),
    },
  };
}

describe('runSkillOffer', () => {
  it('installs only the skills answered yes', async () => {
    const { io, calls } = ioWith(['y', 'n']);
    const installed = await runSkillOffer(two, io);
    expect(installed).toEqual(['one']);
    expect(calls).toEqual([
      ['marketplace', 'add', 'a/one'],
      ['install', 'one@one'],
    ]);
  });

  it('installs nothing when every answer is no or empty (the default)', async () => {
    const { io, calls } = ioWith(['', 'n']);
    const installed = await runSkillOffer(two, io);
    expect(installed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('accepts Italian and English yes spellings', async () => {
    for (const yes of ['y', 'yes', 's', 'si', 'sì', 'Y', 'Si']) {
      const { io } = ioWith([yes]);
      const installed = await runSkillOffer([two[0] as RecommendedSkill], io);
      expect(installed).toEqual(['one']);
    }
  });

  it('does not stop the offer when one install fails, and reports it', async () => {
    const { io, printed } = ioWith(['y', 'y'], false);
    const installed = await runSkillOffer(two, io);
    expect(installed).toEqual([]);
    expect(printed.some((l) => l.includes('install failed'))).toBe(true);
  });

  it('the curated list carries the marketplace and plugin coordinates', () => {
    for (const s of RECOMMENDED_SKILLS) {
      expect(s.marketplace).toMatch(/\//);
      expect(s.plugin).toMatch(/@/);
    }
  });
});
