/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- jest.mock factories and spec replay need require() */
import './probe-mocks';
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
import { ALL_DESCRIPTORS } from '../../src/modules/streaming/transcoding/codec/encoders';
import { syntheticArgvVectors } from './argv-cases';
import { genArgvVector } from './argv-fuzz';
import { mockRecord, recorder } from './argv-recorder';
import { argvHash, runArgvVector, type ArgvVector } from './argv-vector';
import { mulberry32 } from './fuzz';
import { slug, sortKeys } from './vector';

jest.mock('../../src/modules/streaming/transcoding/ffmpeg-args', () => {
  const actual = jest.requireActual(
    '../../src/modules/streaming/transcoding/ffmpeg-args',
  );
  const { mockRecord: rec } = require('./argv-recorder');
  return {
    ...actual,
    buildFfmpegArgs: rec('vod', actual.buildFfmpegArgs),
    buildRemuxArgs: rec('remux', actual.buildRemuxArgs),
  };
});
jest.mock('../../src/modules/streaming/transcoding/iframe-trick-play', () => {
  const actual = jest.requireActual(
    '../../src/modules/streaming/transcoding/iframe-trick-play',
  );
  const { mockRecord: rec } = require('./argv-recorder');
  return {
    ...actual,
    buildIFrameSegmentArgs: rec('iframe', actual.buildIFrameSegmentArgs),
  };
});
jest.mock('../../src/modules/livetv/services/live-ffmpeg-args', () => {
  const actual = jest.requireActual(
    '../../src/modules/livetv/services/live-ffmpeg-args',
  );
  const { mockRecord: rec } = require('./argv-recorder');
  return {
    ...actual,
    buildLiveFfmpegArgs: rec('live', actual.buildLiveFfmpegArgs),
  };
});

// Descriptors are shared objects: patching them in place reaches the encoder specs' imports.
for (const d of ALL_DESCRIPTORS) {
  const own = d.buildArgs.bind(d);
  (d as { buildArgs: typeof d.buildArgs }).buildArgs = mockRecord(
    'encoder',
    own,
    (input) => ({ id: d.id, input }),
    () => recorder.encoders,
  );
}

const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const FUZZ = process.env.ARGV_FUZZ_OUT;
const EXPECT = process.env.ARGV_FUZZ_EXPECT;

const SRC = '../../src/modules';
const REPLAYED_SPECS = [
  'streaming/transcoding/ffmpeg-args.golden',
  'streaming/transcoding/codec/encoders/amf',
  'streaming/transcoding/codec/encoders/nvenc',
  'streaming/transcoding/codec/encoders/hevc-videotoolbox',
  'livetv/services/live-ffmpeg-args',
  'streaming/transcoding/iframe-trick-play',
  'streaming/transcoding/programme-video-map',
  'streaming/transcoding/output-timeline',
  'streaming/transcoding/ts-timeline-offset',
  'streaming/transcoding/subtitle-overlay-filter',
];

const withExpected = (v: ArgvVector): ArgvVector => ({
  ...v,
  input: sortKeys(v.input),
  expected: runArgvVector(v),
});

function writeVectors(repo: string, vectors: ArgvVector[]): void {
  const dir = join(repo, 'fixtures', 'argv');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir))
    // Fuzz-promoted fixtures are hand-curated, not regenerated.
    if (f.endsWith('.json') && !f.startsWith('fuzz-')) rmSync(join(dir, f));
  const used = new Set<string>();
  for (const v of vectors) {
    let file = slug(`${v.kind} ${v.name}`);
    for (let n = 2; used.has(file); n++)
      file = `${slug(`${v.kind} ${v.name}`)}-${n}`;
    used.add(file);
    writeFileSync(
      join(dir, `${file}.json`),
      JSON.stringify(sortKeys(v), null, 2) + '\n',
    );
  }
}

Logger.overrideLogger(false);

if (GEN) {
  for (const s of REPLAYED_SPECS) {
    const short = s.split('/').pop()!;
    describe(`replay ${short}`, () => {
      beforeAll(() => {
        recorder.on = true;
        recorder.spec = short;
        recorder.encoders = s.includes('/encoders/');
      });
      afterAll(() => {
        recorder.on = false;
        recorder.encoders = false;
      });
      require(`${SRC}/${s}.spec`);
    });
  }

  describe('generate argv vectors', () => {
    afterAll(() => {
      const seen = new Set<string>();
      const all: ArgvVector[] = [];
      let unreproducible = 0;
      const replays = recorder.calls.map((c) => {
        const { result, ...v } = c;
        const name = `${c.source}: ${c.name.replace(`replay ${c.source} `, '')}`;
        return { v: { ...v, name } as ArgvVector, result };
      });
      for (const { v, result } of [
        ...replays,
        ...syntheticArgvVectors(GEN).map((v) => ({ v, result: undefined })),
      ]) {
        const out = withExpected(v);
        // A JSON round trip loses what JSON cannot hold (Infinity, functions): drop those calls.
        if (result && JSON.stringify(result) !== JSON.stringify(out.expected)) {
          unreproducible++;
          continue;
        }
        const h = argvHash(out);
        if (seen.has(h)) continue;
        seen.add(h);
        all.push(out);
      }
      const counts: Record<string, number> = {};
      for (const v of all) {
        const k = `${v.source}/${v.kind}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      console.log(
        `argv vectors: ${all.length} ${JSON.stringify(counts)}, unreproducible ${unreproducible}`,
      );
      writeVectors(GEN, all);
    });
    it('writes fixtures/argv', () =>
      expect(recorder.calls.length).toBeGreaterThan(0));
  });
} else if (EXPECT) {
  it('recomputes `expected` of every argv vector file in ARGV_FUZZ_EXPECT', () => {
    for (const f of readdirSync(EXPECT).filter((x) => x.endsWith('.json'))) {
      const v = JSON.parse(readFileSync(join(EXPECT, f), 'utf8')) as ArgvVector;
      writeFileSync(
        join(EXPECT, f),
        JSON.stringify(sortKeys(withExpected(v)), null, 2) + '\n',
      );
    }
  });
} else if (FUZZ) {
  const seed = Number(process.env.ARGV_FUZZ_SEED ?? 1);
  const count = Number(process.env.ARGV_FUZZ_COUNT ?? 4000);
  it(`argv fuzz seed ${seed} x ${count} -> ${FUZZ}`, () => {
    mkdirSync(FUZZ, { recursive: true });
    const file = join(FUZZ, `argv-fuzz-${seed}.ndjson`);
    rmSync(file, { force: true });
    const rng = mulberry32(seed);
    const throws: Record<string, number> = {};
    const kinds: Record<string, number> = {};
    let buf: string[] = [];
    for (let i = 0; i < count; i++) {
      const v = withExpected(genArgvVector(rng, `fuzz-${seed}-${i}`));
      kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
      if (v.expected && 'error' in v.expected) {
        const m = v.expected.error;
        throws[m] = (throws[m] ?? 0) + 1;
      }
      buf.push(JSON.stringify(sortKeys({ seed, i, ...v })));
      if (buf.length >= 200 || i === count - 1) {
        appendFileSync(file, buf.map((l) => l + '\n').join(''));
        buf = [];
      }
    }
    writeFileSync(
      join(FUZZ, `argv-fuzz-${seed}.throws.json`),
      JSON.stringify({ seed, count, kinds, throws }, null, 2) + '\n',
    );
    console.log(
      `argv fuzz seed ${seed}: ${JSON.stringify(kinds)} throws ${JSON.stringify(throws)}`,
    );
  }, 600_000);
} else if (CHECK) {
  const dir = join(CHECK, 'fixtures', 'argv');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  describe('argv vectors match the engine checkout', () => {
    it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
    it.each(files)('%s', (f) => {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ArgvVector;
      expect(sortKeys(runArgvVector(v))).toEqual(v.expected);
    });
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO to generate, or FLIKS_ENGINE_REPO_CHECK to verify, argv vectors', () =>
    undefined);
}
