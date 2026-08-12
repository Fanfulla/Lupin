// Wordmark for the CLI header (usage screen) and, later, for the
// TUI (ROADMAP backlog #8). Box-drawing glyphs only, the same set the CLI
// already prints (✓, ⚠, …): no colour, no emoji, no dependency, so a redirected
// stdout keeps it readable and a pipe stays clean.

import { CLIENT_VERSION } from '../providers/identity.js';

const WORDMARK = [
  '██╗     ██╗   ██╗██████╗ ██╗███╗   ██╗',
  '██║     ██║   ██║██╔══██╗██║████╗  ██║',
  '██║     ██║   ██║██████╔╝██║██╔██╗ ██║',
  '██║     ██║   ██║██╔═══╝ ██║██║╚██╗██║',
  '███████╗╚██████╔╝██║     ██║██║ ╚████║',
  '╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝',
] as const;

const WIDTH = 38; // every wordmark row is exactly this wide

export const TAGLINE = 'The definitive Claude Code router';
const SUBLINE = 'any provider, your setup untouched';

/** Full header: wordmark, tagline and version, indented by two spaces. */
export function banner(version: string = CLIENT_VERSION): string {
  const width = Math.max(WIDTH, SUBLINE.length + version.length + 3);
  const pad = ' '.repeat(Math.max(2, width - SUBLINE.length - version.length - 1));
  return [...WORDMARK.map((r) => `  ${r}`), `  ${TAGLINE}`, `  ${SUBLINE}${pad}v${version}`, ''].join('\n');
}

/** One-line mark for tight spots (status lines, future TUI header bar). */
export function bannerLine(version: string = CLIENT_VERSION): string {
  return `╭─ LUPIN v${version} ─ ${TAGLINE} ─╮`;
}
