/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- spec replay needs require() */
import { Logger } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseInitTracks } from '../../src/modules/streaming/transcoding/timeline';
import { mulberry32 } from './fuzz';
import {
  ENCODE,
  RECORDED,
  b64,
  enc,
  kindOf,
  portedError,
  runP,
  type Kind,
  type PVector,
} from './packaging';
import {
  randomHls,
  randomMp4,
  syntheticHls,
  syntheticMp4,
} from './packaging-cases';
import { slug, sortKeys } from './vector';

/**
 * Packaging vectors for the engine's `core::hls` (fixtures/hls) and `core::mp4` (fixtures/mp4).
 *
 *   FLIKS_ENGINE_REPO=<engine>         replay the specs below, recording every call of a ported
 *                                      function, plus the synthetic matrix; `fuzz-*` and `real-*`
 *                                      fixtures are kept and recomputed
 *   PACKAGING_FFMPEG=<ffmpeg> (with ^) re-record the `real-*` fixtures from a generated clip
 *   FLIKS_ENGINE_REPO_CHECK=<engine>   recompute every fixture and compare
 *   PACKAGING_FUZZ_OUT=<dir> [PACKAGING_FUZZ_SEED, PACKAGING_FUZZ_COUNT]  seeded NDJSON per kind
 */

const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const FUZZ = process.env.PACKAGING_FUZZ_OUT;
const FFMPEG = process.env.PACKAGING_FFMPEG;
const T = '../../src/modules/streaming/transcoding';
const SPECS: string[] = [
  `${T}/master-playlist.golden.spec`,
  `${T}/master-playlist.spec`,
  '../../src/modules/streaming/streaming.controller.spec',
  `${T}/timeline.spec`,
  `${T}/cmaf-rewrite.spec`,
  `${T}/remux-assembler.spec`,
  `${T}/segment-boundaries.spec`,
  `${T}/source-timeline.spec`,
  `${T}/output-timeline.spec`,
];
// Fixtures stay small: bigger calls are dropped, and a spec's calls of one function capped.
const MAX_ARGS_BYTES = 48_000;
const MAX_PER_TEST = 3;
const MAX_PER_SPEC = 20;

function capped(vectors: PVector[]): PVector[] {
  const seen = new Set<string>();
  const n = new Map<string, number>();
  const bump = (k: string, max: number) => {
    const c = (n.get(k) ?? 0) + 1;
    n.set(k, c);
    return c <= max;
  };
  return vectors.filter((v) => {
    const k = key(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return (
      bump(`${v.name}|${v.fn}`, MAX_PER_TEST) &&
      bump(`${v.source}|${v.fn}`, MAX_PER_SPEC)
    );
  });
}

const key = (v: Pick<PVector, 'fn' | 'args'>) =>
  createHash('sha1')
    .update(JSON.stringify(sortKeys({ f: v.fn, a: v.args })))
    .digest('hex');

function dirOf(repo: string, kind: Kind): string {
  return join(repo, 'fixtures', kind);
}

function kept(repo: string, kind: Kind, prefix: string): PVector[] {
  const dir = dirOf(repo, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as PVector);
}

function write(repo: string, kind: Kind, vectors: PVector[]): void {
  const dir = dirOf(repo, kind);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir))
    if (f.endsWith('.json')) rmSync(join(dir, f));
  const used = new Set<string>();
  for (const v of vectors) {
    let file = slug(v.name);
    for (let n = 2; used.has(file); n++) file = `${slug(v.name)}-${n}`;
    used.add(file);
    writeFileSync(
      join(dir, `${file}.json`),
      JSON.stringify(sortKeys(v), null, 2) + '\n',
    );
  }
}

/** One clip cut by ffmpeg's HLS muxer (fMP4) and one audio track fragmented per frame. */
function realVectors(ffmpeg: string): PVector[] {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-clip-'));
  try {
    const src = [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x36:rate=24:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
    ];
    execFileSync(ffmpeg, [
      '-v',
      'error',
      ...src,
      '-c:v',
      'libx264',
      '-bf',
      '2',
      '-g',
      '24',
      '-keyint_min',
      '24',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '24k',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_segment_type',
      'fmp4',
      '-hls_playlist_type',
      'vod',
      join(dir, 'v.m3u8'),
    ]);
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=0.2',
      '-c:a',
      'aac',
      '-b:a',
      '24k',
      '-movflags',
      '+frag_every_frame+empty_moov+default_base_moof',
      '-f',
      'mp4',
      join(dir, 'a.mp4'),
    ]);
    const read = (f: string) => readFileSync(join(dir, f));
    const init = read('init.mp4');
    const segs = readdirSync(dir)
      .filter((f) => f.endsWith('.m4s'))
      .sort();
    const out: PVector[] = [];
    const add = (name: string, fn: string, args: any) =>
      out.push({ name: `real ${name}`, source: 'ffmpeg', fn, args });
    for (const fn of [
      'parseInitTracks',
      'readInitEdits',
      'parseTrexDefaults',
      'cmafRewrite',
      'isCmafRewritten',
    ]) {
      add(
        `init ${fn}`,
        fn,
        fn.startsWith('cmaf') || fn === 'isCmafRewritten'
          ? { buf: b64(init) }
          : { init: b64(init) },
      );
    }
    add('init with edits', 'withInitEdits', {
      init: b64(init),
      seconds: [
        [1, 0.0833],
        [2, 0.0213],
      ],
    });
    const tracks = enc(parseInitTracks(init));
    segs.forEach((s, i) => {
      const seg = read(s);
      add(`${s} cmaf`, 'cmafRewrite', { buf: b64(seg) });
      add(`${s} rewrite`, 'rewriteSegmentTfdt', {
        seg: b64(seg),
        tracks,
        segIndex: i + 3,
        segDuration: 1,
        startPts: 0.08,
      });
      add(`${s} retime`, 'retimeFragments', {
        seg: b64(seg),
        deltas: [
          [1, '1536'],
          [2, '1024'],
        ],
      });
      add(`${s} extent`, 'videoDecodeExtent', {
        moofs: b64(seg),
        trackId: 1,
        trexDefault: 0,
      });
      add(`${s} first tfdt`, 'firstTfdt', { seg: b64(seg), trackId: 2 });
    });
    const a = read('a.mp4');
    const boxes: Buffer[] = [];
    for (let o = 0; o + 8 <= a.length; o += a.readUInt32BE(o))
      boxes.push(a.subarray(o, o + a.readUInt32BE(o)));
    for (let i = 0, n = 0; i + 1 < boxes.length && n < 6; i++) {
      if (boxes[i].toString('latin1', 4, 8) !== 'moof') continue;
      add(`audio frame ${n++}`, 'parseFrame', {
        moof: b64(boxes[i]),
        mdat: b64(boxes[i + 1]),
      });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Logger.overrideLogger(false);

if (GEN) {
  const recorded: PVector[] = [];
  let spec = '';
  for (const [, mod, exp, fn] of RECORDED) {
    const orig = mod[exp];
    mod[exp] = (...a: any[]) => {
      if (!spec) return orig(...a);
      const { args, after } = ENCODE[fn](a);
      const name = `${spec}: ${expect.getState().currentTestName ?? 'case'}`;
      const out = orig(...a);
      after?.();
      if (JSON.stringify(args).length <= MAX_ARGS_BYTES)
        recorded.push({ name, source: spec, fn, args });
      return out;
    };
  }
  for (const s of SPECS) {
    const short = s.split('/').pop()!.replace('.spec', '');
    describe(`replay ${short}`, () => {
      beforeAll(() => (spec = short));
      afterAll(() => (spec = ''));
      spec = short;
      require(s);
      spec = '';
    });
  }
  describe('generate packaging vectors', () => {
    it('writes fixtures/hls and fixtures/mp4', async () => {
      spec = '';
      for (const kind of ['hls', 'mp4'] as Kind[]) {
        const real =
          kind === 'mp4'
            ? FFMPEG
              ? realVectors(FFMPEG)
              : kept(GEN, kind, 'real-')
            : [];
        const all = [
          ...capped(
            recorded.filter((v) => kindOf(v.fn) === kind && v.fn !== 'makeBox'),
          ),
          ...(kind === 'hls' ? syntheticHls() : syntheticMp4()),
          ...real,
          ...kept(GEN, kind, 'fuzz-'),
        ];
        const seen = new Set<string>();
        const out: PVector[] = [];
        for (const v of all) {
          const k = key(v);
          if (seen.has(k)) continue;
          seen.add(k);
          v.expected = sortKeys(await runP(v));
          out.push(v);
        }
        console.log(`${kind} vectors: ${out.length}`);
        write(GEN, kind, out);
      }
    }, 600_000);
  });
} else if (CHECK) {
  for (const kind of ['hls', 'mp4'] as Kind[]) {
    const dir = dirOf(CHECK, kind);
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
      : [];
    describe(`${kind} vectors match the engine checkout`, () => {
      it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
      it.each(files)('%s', async (f) => {
        const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PVector;
        expect(sortKeys(await runP(v))).toEqual(v.expected);
      });
    });
  }
} else if (FUZZ) {
  const seed = Number(process.env.PACKAGING_FUZZ_SEED ?? 1);
  const count = Number(process.env.PACKAGING_FUZZ_COUNT ?? 5000);
  it(`packaging fuzz seed ${seed} x ${count} -> ${FUZZ}`, async () => {
    mkdirSync(FUZZ, { recursive: true });
    for (const [kind, gen] of [
      ['hls', randomHls],
      ['mp4', randomMp4],
    ] as const) {
      const file = join(FUZZ, `${kind}-${seed}.ndjson`);
      rmSync(file, { force: true });
      const rng = mulberry32(seed * 2 + (kind === 'hls' ? 0 : 1));
      const skipped: Record<string, number> = {};
      let lines: string[] = [];
      let ok = 0;
      for (let i = 0; i < count; i++) {
        const v = gen(rng, i);
        const expected = (await runP(v)) as any;
        if (!portedError(expected) || (kind === 'hls' && expected.error)) {
          const m = `${v.fn}: ${expected.type}: ${expected.error}`.slice(
            0,
            120,
          );
          skipped[m] = (skipped[m] ?? 0) + 1;
          continue;
        }
        lines.push(
          JSON.stringify({
            seed,
            i,
            fn: v.fn,
            args: v.args,
            expected: sortKeys(expected),
          }),
        );
        ok++;
        if (lines.length >= 200) {
          appendFileSync(file, lines.map((l) => l + '\n').join(''));
          lines = [];
        }
      }
      appendFileSync(file, lines.map((l) => l + '\n').join(''));
      writeFileSync(
        join(FUZZ, `${kind}-${seed}.skipped.json`),
        JSON.stringify({ seed, ok, skipped }, null, 2) + '\n',
      );
      console.log(
        `${kind} fuzz seed ${seed}: ${ok} ok, skipped ${JSON.stringify(skipped)}`,
      );
      expect(ok).toBeGreaterThan(count / 2);
    }
  }, 600_000);
} else {
  it.skip('set FLIKS_ENGINE_REPO, FLIKS_ENGINE_REPO_CHECK or PACKAGING_FUZZ_OUT for packaging vectors', () =>
    undefined);
}
