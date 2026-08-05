import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapAnthropicRequest, type AnthropicRequest } from '../src/core/request.js';
import { mapOpenAIResponse, type OpenAIResponse } from '../src/core/response.js';
import { OpenAIStreamTranslator } from '../src/core/stream.js';

type Direction = 'request' | 'response' | 'stream' | 'dialect';

interface Fixture {
  name: string;
  spec: string;
  direction: Direction;
  quirks?: string[];
  input: unknown;
  expected: unknown;
}

// direction → pure core function. Filled in as src/core lands (M2).
// A fixture whose direction has no implementation fails: fixture-first, red before green.
const DISPATCH: Record<Direction, ((input: unknown, quirks: string[]) => unknown) | null> = {
  request: (input, quirks) => mapAnthropicRequest(input as AnthropicRequest, quirks),
  response: (input) => mapOpenAIResponse(input as OpenAIResponse),
  stream: (input) => {
    const translator = new OpenAIStreamTranslator();
    const events = (input as string[]).flatMap((chunk) => translator.push(chunk));
    return [...events, ...translator.finish()];
  },
  dialect: null,
};

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

interface LoadedFixture {
  area: string;
  file: string;
  fixture: Fixture;
}

function collectFixtures(): LoadedFixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  const out: LoadedFixture[] = [];
  const areas = readdirSync(FIXTURES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const area of areas) {
    const dir = join(FIXTURES_DIR, area.name);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fixture;
      if (typeof fixture.name !== 'string' || !(fixture.direction in DISPATCH)) {
        throw new Error(`malformed fixture ${area.name}/${file}: needs "name" and a valid "direction"`);
      }
      out.push({ area: area.name, file, fixture });
    }
  }
  return out;
}

const all = collectFixtures();

describe('fixture runner', () => {
  if (all.length === 0) {
    it('is ready — no fixtures yet, first ones land with M2', () => {
      expect(Object.keys(DISPATCH)).toEqual(['request', 'response', 'stream', 'dialect']);
    });
    return;
  }
  for (const { area, fixture } of all) {
    it(`${area}/${fixture.name} [${fixture.direction}] — ${fixture.spec}`, () => {
      const impl = DISPATCH[fixture.direction];
      if (!impl) {
        throw new Error(
          `no core implementation for direction "${fixture.direction}" yet (fixture-first: implement it in src/core)`,
        );
      }
      expect(impl(fixture.input, fixture.quirks ?? [])).toEqual(fixture.expected);
    });
  }
});
