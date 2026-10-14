import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  dvStandaloneCodecs,
  dvSupplementalCodecs,
  type DvStream,
} from '../../src/modules/streaming/transcoding/codec/dolby-vision';

/**
 * Golden Dolby Vision CODECS strings of the HLS master (`fixtures/hls/dv-codecs.json`) over a field matrix:
 * `[supplemental, standalone]` per case, from `dvSupplementalCodecs` and `dvStandaloneCodecs`.
 *
 *   FLIKS_ENGINE_REPO=<engine>        rewrite the fixture
 *   FLIKS_ENGINE_REPO_CHECK=<engine>  recompute from the stored cases and compare
 */
const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const FILE = ['fixtures', 'hls', 'dv-codecs.json'];

function cases(): DvStream[] {
  const out: DvStream[] = [];
  const pixels = [
    ['tv', 'bt2020nc', 'yuv420p10le'],
    ['tv', 'bt2020nc', 'yuv420p10'],
    ['pc', 'bt2020nc', 'yuv420p10le'],
    ['tv', 'bt709', 'yuv420p10le'],
    ['tv', 'bt2020nc', 'yuv420p'],
    [undefined, undefined, undefined],
  ];
  for (const dvProfile of [undefined, 5, 7, 8, 10])
    for (const dvLevel of [undefined, 0, 6, 13])
      for (const dvBlSignalCompatId of [undefined, 0, 1, 2, 4])
        for (const hdrFormat of [undefined, 'HDR10', 'HLG'])
          for (const [colorRange, colorSpace, pixelFormat] of pixels)
            out.push(
              Object.fromEntries(
                Object.entries({
                  dvProfile,
                  dvLevel,
                  dvBlSignalCompatId,
                  hdrFormat,
                  colorRange,
                  colorSpace,
                  pixelFormat,
                }).filter(([, x]) => x !== undefined),
              ),
            );
  return out;
}

const compute = (c: DvStream[]) =>
  c.map((v) => [dvSupplementalCodecs(v), dvStandaloneCodecs(v)]);

if (GEN) {
  it('writes fixtures/hls/dv-codecs.json', () => {
    const args = { cases: cases() };
    mkdirSync(join(GEN, 'fixtures', 'hls'), { recursive: true });
    writeFileSync(
      join(GEN, ...FILE),
      JSON.stringify({
        name: 'dv-codecs',
        source: 'ts',
        fn: 'dvCodecs',
        args,
        expected: { ok: compute(args.cases) },
      }) + '\n',
    );
    expect(args.cases.length).toBeGreaterThan(0);
  });
} else if (CHECK) {
  describe('dv codecs vector matches the engine checkout', () => {
    it('has the fixture', () =>
      expect(existsSync(join(CHECK, ...FILE))).toBe(true));
    it('recomputes every case', () => {
      const v = JSON.parse(readFileSync(join(CHECK, ...FILE), 'utf8')) as {
        args: { cases: DvStream[] };
        expected: { ok: unknown[] };
      };
      expect(v.args.cases).toEqual(cases());
      expect(compute(v.args.cases)).toEqual(v.expected.ok);
    });
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO to generate, or FLIKS_ENGINE_REPO_CHECK to verify, the dv codecs vector', () =>
    undefined);
}
