/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vector files are plain JSON */
import { Logger } from '@nestjs/common';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { allVectors, FUZZ_KINDS, fuzzSeed } from './session-cases';
import {
  cleanupSession,
  runSession,
  type SessionMatrix,
  type SessionVector,
} from './session-vectors';
import { slug, sortKeys } from './vector';

/**
 * Golden vectors of the engine's `core::session` (`fixtures/session`), from the real services.
 *
 *   FLIKS_ENGINE_REPO=<engine>        rewrite fixtures/session (fuzz-* promoted files are kept)
 *   FLIKS_ENGINE_REPO_CHECK=<engine>  replay every fixture and compare with `expected`
 *   SESSION_FUZZ_OUT=<dir> [SESSION_FUZZ_SEED=1] [SESSION_FUZZ_COUNT=10000]
 *                                     seeded NDJSON for the engine's `session_fuzz` test
 *   SESSION_FUZZ_EXPECT=<dir>         recompute `expected` of the vector files in <dir>
 */
const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const FUZZ = process.env.SESSION_FUZZ_OUT;
const EXPECT = process.env.SESSION_FUZZ_EXPECT;
const LONG = 900_000;

const isMatrix = (v: SessionVector | SessionMatrix): v is SessionMatrix =>
  'cases' in v;

async function fill(v: SessionVector | SessionMatrix): Promise<void> {
  if (isMatrix(v)) {
    for (const c of v.cases)
      c.expected = sortKeys(await runSession(v.kind, c.input));
  } else {
    v.expected = sortKeys(await runSession(v.kind, v.input));
  }
}

/** One case per line keeps the big matrices reviewable. */
function serialise(v: SessionVector | SessionMatrix): string {
  if (!isMatrix(v)) return JSON.stringify(sortKeys(v), null, 2) + '\n';
  const lines = v.cases.map((c) => JSON.stringify(sortKeys(c)));
  const head = JSON.stringify({ name: v.name, source: v.source, kind: v.kind });
  return `${head.slice(0, -1)},"cases":[\n${lines.join(',\n')}\n]}\n`;
}

Logger.overrideLogger(false);
afterAll(cleanupSession);

if (GEN) {
  it(
    'writes fixtures/session',
    async () => {
      const dir = join(GEN, 'fixtures', 'session');
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir))
        if (f.endsWith('.json') && !f.startsWith('fuzz-')) rmSync(join(dir, f));
      const used = new Set<string>();
      let cases = 0;
      for (const v of allVectors()) {
        await fill(v);
        cases += isMatrix(v) ? v.cases.length : 1;
        let file = (isMatrix(v) ? 'matrix-' : '') + slug(`${v.kind}-${v.name}`);
        for (let n = 2; used.has(file); n++) file = `${file}-${n}`;
        used.add(file);
        writeFileSync(join(dir, `${file}.json`), serialise(v));
      }
      console.log(`session vectors: ${used.size} files, ${cases} cases`);
    },
    LONG,
  );
} else if (FUZZ) {
  const seed = Number(process.env.SESSION_FUZZ_SEED ?? 1);
  const count = Number(process.env.SESSION_FUZZ_COUNT ?? 10_000);
  it(
    `session fuzz seed ${seed} x ${count} -> ${FUZZ}`,
    async () => {
      mkdirSync(FUZZ, { recursive: true });
      const file = join(FUZZ, `session-${seed}.ndjson`);
      rmSync(file, { force: true });
      const rng = fuzzSeed(seed);
      const done: Record<string, number> = {};
      for (const { kind, weight, gen } of FUZZ_KINDS) {
        const n = Math.max(1, Math.round(count * weight));
        let buf: string[] = [];
        for (let i = 0; i < n; i++) {
          const input = gen(rng);
          const expected = sortKeys(await runSession(kind, input));
          buf.push(JSON.stringify({ seed, i, kind, input, expected }));
          if (buf.length >= 500 || i === n - 1) {
            appendFileSync(file, buf.map((l) => l + '\n').join(''));
            buf = [];
          }
        }
        done[kind] = n;
      }
      console.log(`session fuzz seed ${seed}: ${JSON.stringify(done)}`);
    },
    LONG,
  );
} else if (EXPECT) {
  it(
    'recomputes `expected` of every vector file in SESSION_FUZZ_EXPECT',
    async () => {
      for (const f of readdirSync(EXPECT).filter((x) => x.endsWith('.json'))) {
        const v = JSON.parse(readFileSync(join(EXPECT, f), 'utf8')) as
          | SessionVector
          | SessionMatrix;
        await fill(v);
        writeFileSync(join(EXPECT, f), serialise(v));
      }
    },
    LONG,
  );
} else if (CHECK) {
  const dir = join(CHECK, 'fixtures', 'session');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  describe('session vectors match the engine checkout', () => {
    it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
    it.each(files)(
      '%s',
      async (f) => {
        const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as
          | SessionVector
          | SessionMatrix;
        const cases = isMatrix(v)
          ? v.cases.map((c) => ({ ...c, kind: v.kind }))
          : [
              {
                name: v.name,
                input: v.input,
                expected: v.expected,
                kind: v.kind,
              },
            ];
        for (const c of cases) {
          expect([c.name, sortKeys(await runSession(c.kind, c.input))]).toEqual(
            [c.name, c.expected],
          );
        }
      },
      LONG,
    );
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO to generate, or FLIKS_ENGINE_REPO_CHECK to verify, session vectors', () =>
    undefined);
}
