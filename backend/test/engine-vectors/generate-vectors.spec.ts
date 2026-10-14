/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment -- jest.mock factories and spec replay need require() */
import { Logger } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { join } from 'path';
import { StreamingController } from '../../src/modules/streaming/streaming.controller';
import { evaluateRecorder } from '../../src/modules/streaming/stream-builder.test-helpers';
import { syntheticVectors } from './cases';
import { genVector, mulberry32 } from './fuzz';
import { HOST_CAPS } from './host-caps';
import {
  DEFAULT_CONFIG,
  inputHash,
  runVector,
  slug,
  sortKeys,
  wireDevice,
  wireInfo,
  wireScan,
  type Vector,
} from './vector';

// Host capabilities are process-global boot probes: route every probe through host-caps.ts.
function mockProbes(path: string, map: Record<string, string>) {
  const hc = require('./host-caps') as typeof import('./host-caps');
  const actual = jest.requireActual<object>(path);
  return {
    ...actual,
    ...Object.fromEntries(
      Object.entries(map).map(([fn, name]) => [
        fn,
        () => hc.probeOn(name as never),
      ]),
    ),
  };
}
jest.mock(
  '../../src/modules/streaming/transcoding/codec/tonemap-opencl-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/tonemap-opencl-probe',
      {
        isTonemapOpenclEnabled: 'tonemapOpencl',
        isTonemapOpenclEnabledWithCrop: 'tonemapOpenclCrop',
        isTonemapOpenclHdr10Enabled: 'tonemapOpenclHdr10',
      },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/qsv-opencl-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/qsv-opencl-probe',
      {
        isQsvOpenclTonemapEnabled: 'qsvOpencl',
        isQsvOpenclTonemapHdr10Enabled: 'qsvOpenclHdr10',
      },
    ),
);
jest.mock('../../src/modules/streaming/transcoding/codec/vpp-qsv-probe', () =>
  mockProbes('../../src/modules/streaming/transcoding/codec/vpp-qsv-probe', {
    isVppQsvTonemapEnabled: 'vppQsv',
  }),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/vulkan-tonemap-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/vulkan-tonemap-probe',
      { isVulkanTonemapEnabled: 'vulkan' },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/cuda-tonemap-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/cuda-tonemap-probe',
      {
        isCudaTonemapEnabled: 'cuda',
        isCudaTonemapHdr10Enabled: 'cudaHdr10',
      },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/opencl-tonemap-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/opencl-tonemap-probe',
      {
        isOpenclTonemapEnabled: 'opencl',
        isOpenclTonemapHdr10Enabled: 'openclHdr10',
      },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/amf-opencl-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/amf-opencl-probe',
      { isAmfOpenclEnabled: 'amfOpencl' },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/audio-encoder-probe',
  () => ({
    ...jest.requireActual(
      '../../src/modules/streaming/transcoding/audio-encoder-probe',
    ),
    isLibfdkAacEnabled: () =>
      (require('./host-caps') as typeof import('./host-caps')).currentCaps()
        .libfdkAac,
  }),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/encoder-probe',
  () => ({
    ...jest.requireActual(
      '../../src/modules/streaming/transcoding/codec/encoder-probe',
    ),
    isEncoderEnabled: (id: string) =>
      !(require('./host-caps') as typeof import('./host-caps'))
        .currentCaps()
        .disabledEncoders.includes(id),
    vaapiWritesHdrMetadata: () =>
      (require('./host-caps') as typeof import('./host-caps')).currentCaps()
        .vaapiWritesHdrMetadata,
  }),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/decoder-probe',
  () => ({
    ...jest.requireActual(
      '../../src/modules/streaming/transcoding/codec/decoder-probe',
    ),
    isDecoderEnabled: (id: string) =>
      !(require('./host-caps') as typeof import('./host-caps'))
        .currentCaps()
        .disabledDecoders.includes(id),
  }),
);

const GEN = process.env.FLIKS_ENGINE_REPO;
const FUZZ = process.env.FUZZ_OUT;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const REPLAYED_SPECS = [
  'audio-decision',
  'dovi-play-method',
  'direct-stream-guards',
  'negotiated-quality',
  'crop-local',
  'hdr-local-tonemap',
];

const outcome = (e: unknown) =>
  (e as { response: { playMethod: string } }).response.playMethod;

/** Non-transcode outcomes that only differ from the cpu run in the reported encoder carry no
 *  new rule: drop them, keeping one DirectStream per host for the hwAccel report. */
function prune(vectors: Vector[]): Vector[] {
  const mask = (e: unknown) => {
    const c = JSON.parse(JSON.stringify(e)) as {
      response: Record<string, unknown>;
      videoVariant: unknown;
    };
    delete c.response.hwAccel;
    delete c.videoVariant;
    return JSON.stringify(sortKeys(c));
  };
  const cpu = new Map<string, string>();
  const key = (v: Vector) =>
    v.name.replace(
      / (cpu|vaapi|nvenc|videotoolbox|qsv|vaapi-no-opencl) /,
      ' * ',
    );
  for (const v of vectors)
    if (v.hostCaps === HOST_CAPS.cpu) cpu.set(key(v), mask(v.expected));
  const seenStream = new Set<string>();
  return vectors.filter((v) => {
    if (
      v.source !== 'synthetic' ||
      v.hostCaps === HOST_CAPS.cpu ||
      outcome(v.expected) === 'Transcode'
    )
      return true;
    if (cpu.get(key(v)) !== mask(v.expected)) return true;
    if (outcome(v.expected) !== 'DirectStream') return false;
    const k = `${v.hostCaps.hwAccel}`;
    if (seenStream.has(k)) return false;
    seenStream.add(k);
    return true;
  });
}

const ESTIMATE_FILE_SIZES = [0, 1_500_000_000];

/** Runs the real controller method; only the file resolution is stubbed. */
async function estimateExpected(info: Vector['input']['info'], size: number) {
  const ctl = {
    streamingService: {
      resolveFile: () =>
        Promise.resolve({ mediaFile: { id: 1, streamInfo: info }, size }),
    },
  };
  return sortKeys(
    JSON.parse(
      JSON.stringify(
        await StreamingController.prototype.downloadQualities.call(
          ctl as never,
          { user: {} } as never,
          1,
        ),
      ),
    ),
  );
}

interface EstimateVector {
  name: string;
  input: { info: Vector['input']['info']; fileSize: number };
  expected: unknown;
}

async function estimateVectors(vectors: Vector[]): Promise<EstimateVector[]> {
  const seen = new Set<string>();
  const out: EstimateVector[] = [];
  for (const v of vectors) {
    const key = JSON.stringify(sortKeys(v.input.info));
    if (seen.has(key)) continue;
    seen.add(key);
    for (const fileSize of ESTIMATE_FILE_SIZES)
      out.push({
        name: `${v.name} size ${fileSize}`,
        input: { info: v.input.info, fileSize },
        expected: await estimateExpected(v.input.info, fileSize),
      });
  }
  return out;
}

function writeEstimateVectors(repo: string, vectors: EstimateVector[]): void {
  const dir = join(repo, 'fixtures', 'estimate-sizes');
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

function writeVectors(repo: string, vectors: Vector[]): void {
  const dir = join(repo, 'fixtures', 'decide');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir))
    // Fuzz-promoted fixtures are hand-curated, not regenerated.
    if (f.endsWith('.json') && !f.startsWith('fuzz-')) rmSync(join(dir, f));
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

Logger.overrideLogger(false);

if (GEN) {
  const replays: Vector[] = [];
  let spec = '';
  evaluateRecorder.current = (input, result) => {
    const { resolved, profile, settings } = input;
    const info = resolved.mediaFile.streamInfo;
    if (!info) return;
    const name = (expect.getState().currentTestName ?? 'case').replace(
      `replay ${spec} `,
      `${spec}: `,
    );
    replays.push({
      name,
      source: spec,
      input: {
        media: {
          mediaFileId: resolved.mediaFile.id,
          path: resolved.absolutePath,
          ext: resolved.ext,
          contentType: resolved.contentType,
        },
        info: wireInfo(info),
        scan: wireScan(input.sourceScan),
        device: wireDevice(profile),
        selection: JSON.parse(
          JSON.stringify({
            tokenParam: input.tokenParam,
            burnInSubtitleId: input.burnInSubtitleId,
            burnInIsText: input.burnInIsText,
            requestedQuality: input.requestedQuality,
            audioStreamIndex: input.audioStreamIndex,
          }),
        ),
      },
      hostCaps: HOST_CAPS.cpu,
      config: {
        autoCropEnabled: settings.autoCropEnabled,
        tonemapAlgo: settings.tonemapAlgo,
        autoQualityMode: settings.autoQualityMode,
        segmentDuration: settings.segmentDuration,
      },
      expected: JSON.parse(JSON.stringify(result)),
    });
  };
  for (const s of REPLAYED_SPECS) {
    spec = s;
    describe(`replay ${s}`, () => {
      beforeAll(() => {
        spec = s;
      });

      require(`../../src/modules/streaming/${s}.spec`);
    });
  }

  describe('generate decide vectors', () => {
    afterAll(async () => {
      evaluateRecorder.current = undefined;
      const seen = new Set<string>();
      const all: Vector[] = [];
      for (const v of [...replays, ...syntheticVectors()]) {
        v.expected = runVector(v);
        const h = inputHash(v);
        if (seen.has(h)) continue;
        seen.add(h);
        all.push(v);
      }
      const pruned = prune(all);
      const bySource: Record<string, number> = {};
      for (const v of pruned)
        bySource[v.source] = (bySource[v.source] ?? 0) + 1;

      console.log(
        `decide vectors: ${pruned.length} ${JSON.stringify(bySource)}`,
      );
      writeVectors(GEN, pruned);
      const est = await estimateVectors(pruned);
      console.log(`estimate-sizes vectors: ${est.length}`);
      writeEstimateVectors(GEN, est);
    });
    it('writes fixtures/decide', () => {
      expect(DEFAULT_CONFIG.segmentDuration).toBe(3);
    });
  });
} else if (process.env.FUZZ_EXPECT) {
  const dir = process.env.FUZZ_EXPECT;
  it('recomputes `expected` of every vector file in FUZZ_EXPECT', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Vector;
      v.expected = runVector(v);
      writeFileSync(join(dir, f), JSON.stringify(sortKeys(v), null, 2) + '\n');
    }
  });
} else if (FUZZ) {
  const seed = Number(process.env.FUZZ_SEED ?? 1);
  const count = Number(process.env.FUZZ_COUNT ?? 5000);
  it(`fuzz seed ${seed} x ${count} -> ${FUZZ}`, () => {
    mkdirSync(FUZZ, { recursive: true });
    const file = join(FUZZ, `fuzz-${seed}.ndjson`);
    rmSync(file, { force: true });
    const rng = mulberry32(seed);
    const throws: Record<string, number> = {};
    let buf: string[] = [];
    let ok = 0;
    for (let i = 0; i < count; i++) {
      const v = genVector(rng, `fuzz-${seed}-${i}`);
      try {
        const expected = runVector(v);
        buf.push(
          JSON.stringify({
            seed,
            i,
            input: v.input,
            hostCaps: v.hostCaps,
            config: v.config,
            expected: sortKeys(expected),
          }),
        );
        ok++;
      } catch (e) {
        const m = (e as Error).message;
        throws[m] = (throws[m] ?? 0) + 1;
      }
      if (buf.length >= 200 || i === count - 1) {
        appendFileSync(file, buf.map((l) => l + '\n').join(''));
        buf = [];
      }
    }
    writeFileSync(
      join(FUZZ, `fuzz-${seed}.throws.json`),
      JSON.stringify({ seed, ok, throws }, null, 2) + '\n',
    );
    console.log(
      `fuzz seed ${seed}: ${ok} ok, throws ${JSON.stringify(throws)}`,
    );
    expect(ok).toBeGreaterThan(0);
  }, 600_000);
} else if (CHECK) {
  const dir = join(CHECK, 'fixtures', 'decide');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  describe('decide vectors match the engine checkout', () => {
    it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
    it.each(files)('%s', (f) => {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Vector;
      expect(sortKeys(runVector(v))).toEqual(v.expected);
    });
  });
  const estDir = join(CHECK, 'fixtures', 'estimate-sizes');
  const estFiles = existsSync(estDir)
    ? readdirSync(estDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  describe('estimate-sizes vectors match the engine checkout', () => {
    it('has fixtures', () => expect(estFiles.length).toBeGreaterThan(0));
    it.each(estFiles)('%s', async (f) => {
      const v = JSON.parse(
        readFileSync(join(estDir, f), 'utf8'),
      ) as EstimateVector;
      expect(await estimateExpected(v.input.info, v.input.fileSize)).toEqual(
        v.expected,
      );
    });
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO to generate, or FLIKS_ENGINE_REPO_CHECK to verify, decide vectors', () =>
    undefined);
}
