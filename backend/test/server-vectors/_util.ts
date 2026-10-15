import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Inputs are JSON-roundtripped first so `expected` comes from exactly what a Rust replay reads.
// Layout matches the engine's Rust Fixture::save: one case per line.
export async function emit(domain: string, inputs: unknown[], run: (input: any) => unknown): Promise<void> {
  const cases: string[] = [];
  for (const i of inputs) {
    const input = JSON.parse(JSON.stringify(i));
    cases.push(JSON.stringify({ input, expected: await run(input) }));
  }
  const dir = join(__dirname, '../../../server/fixtures', domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cases.json'), `{"cases":[\n${cases.join(',\n')}\n]}\n`, 'utf8');
}

export const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
export const ri = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
export const maybe = <T>(rng: () => number, v: T, p = 0.5): T | undefined => (rng() < p ? v : undefined);
