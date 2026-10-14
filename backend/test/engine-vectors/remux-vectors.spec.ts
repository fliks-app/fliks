import { execFileSync } from 'child_process';
import type { Logger } from '@nestjs/common';
import {
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
import {
  buildRemuxArgs,
  remuxAudioGrid,
  remuxRunStart,
  type BuildRemuxArgsOptions,
} from '../../src/modules/streaming/transcoding/ffmpeg-args';
import {
  RemuxSegmentAssembler,
  remuxAssemblyPlan,
} from '../../src/modules/streaming/transcoding/remux-assembler';
import { remuxSegmentGrid } from '../../src/modules/streaming/transcoding/segment-boundaries';
import { scanVideoPackets } from '../../src/modules/streaming/transcoding/video-packets';
import { sortKeys } from './vector';

/**
 * Golden runs of the real remux segment assembler for the engine's `core::mp4` (`fixtures/mp4/assembler`):
 * the GOP files a remux run wrote (`input`, base64) and the segments served from them (`expected`).
 *
 *   FLIKS_ENGINE_REPO=<engine>        recompute `expected` of the stored runs
 *   REMUX_TOOLS=<bin dir with ffmpeg, ffprobe>
 *                                     with it, re-record the runs from freshly encoded clips
 *   FLIKS_ENGINE_REPO_CHECK=<engine>  replay every run and compare, no tools needed
 */
const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const TOOLS = process.env.REMUX_TOOLS;
const SEGMENT_SECONDS = 3;
const log = { log() {}, warn() {}, error() {} } as unknown as Logger;

type Files = Record<string, string>;
interface Run {
  name: string;
  source: string;
  fn: string;
  scan: { keyframes: unknown[]; end: number; origin: number };
  grid: Parameters<typeof remuxAssemblyPlan>[0]['grid'];
  run: Parameters<typeof remuxAssemblyPlan>[0]['run'];
  plan: Omit<ReturnType<typeof remuxAssemblyPlan>, 'dir' | 'gopDir'>;
  input: Files;
  expected?: {
    files: Files;
    videoFrontier: unknown;
    audioFrontiers: unknown[];
  };
}

const b64dir = (dir: string, rel = ''): Files => {
  const out: Files = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, b64dir(dir, r));
    else if (!e.name.endsWith('.m3u8'))
      out[r] = readFileSync(join(dir, r)).toString('base64');
  }
  return out;
};

const withoutDirs = (p: ReturnType<typeof remuxAssemblyPlan>): Run['plan'] => {
  const { dir, gopDir, ...plan } = p;
  void [dir, gopDir];
  return plan;
};

/** The plan is derived from the stored scan, grid and run, then the stored GOP files are assembled. */
async function replay(
  v: Run,
): Promise<{ plan: Run['plan']; expected: Run['expected'] }> {
  const work = mkdtempSync(join(tmpdir(), 'remux-vec-'));
  try {
    const gopDir = join(work, 'gop-run');
    for (const [rel, data] of Object.entries(v.input)) {
      mkdirSync(join(gopDir, rel, '..'), { recursive: true });
      writeFileSync(join(gopDir, rel), Buffer.from(data, 'base64'));
    }
    const { startSegment, segmentDuration, audioRenditions } = v.plan;
    const full = remuxAssemblyPlan({
      dir: work,
      gopDir,
      grid: v.grid,
      startSegment,
      run: v.run,
      origin: v.scan.origin,
      segmentDuration,
      audioRenditions,
    });
    const a = new RemuxSegmentAssembler(full, log, v.name);
    await a.finish(true);
    return {
      plan: withoutDirs(full),
      expected: {
        files: b64dir(work),
        videoFrontier: a.videoFrontier(),
        audioFrontiers: Array.from({ length: full.audioRenditions }, (_, i) =>
          a.audioFrontier(i + 1),
        ),
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const dir = (repo: string) => join(repo, 'fixtures', 'mp4', 'assembler');
const load = (repo: string): Run[] =>
  existsSync(dir(repo))
    ? readdirSync(dir(repo))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dir(repo), f), 'utf8')) as Run)
    : [];
const serialise = (v: Run) => JSON.stringify(v, null, 1) + '\n';

/** A clip with keyframes off the segment grid and `tracks` sine audio tracks. */
function clip(work: string, name: string, tracks: number): string {
  const out = join(work, name);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=8',
  ];
  for (let i = 0; i < tracks; i++)
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${440 * (i + 1)}:sample_rate=48000:duration=8`,
    );
  args.push('-map', '0:v');
  for (let i = 0; i < tracks; i++) args.push('-map', `${i + 1}:a`);
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '51',
    '-g',
    '1000',
    '-force_key_frames',
    '0,1.1,2.3,3,4.6,5.2,6.9',
    '-c:a',
    'aac',
    '-b:a',
    '16k',
    '-ac',
    '2',
    '-shortest',
    out,
  );
  execFileSync(join(TOOLS!, 'ffmpeg'), args);
  return out;
}

interface Scenario {
  name: string;
  file: string;
  tracks: number;
  start: number;
  useGrid: boolean;
  plans: { mode: 'copy' | 'transcode'; codec: string; channels: number }[];
}

async function record(work: string, o: Scenario): Promise<Run> {
  const scan = await scanVideoPackets(
    o.file,
    { streamIndex: 0 },
    { mpegTs: false },
  );
  const packets = JSON.parse(
    execFileSync(join(TOOLS!, 'ffprobe'), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_packets',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'json',
      o.file,
    ]).toString(),
  ) as { packets: { pts_time: string }[] };
  const origin = Math.min(...packets.packets.map((p) => +p.pts_time));
  const s = { keyframes: scan.keyframes, end: scan.end, origin };
  const grid = o.useGrid
    ? remuxSegmentGrid(s as never, origin, SEGMENT_SECONDS, '24/1')
    : null;
  const multi = o.tracks > 1;
  const basis = o.plans.find((p) => p.mode === 'transcode') ?? o.plans[0];
  const run = remuxRunStart(
    grid,
    o.start,
    SEGMENT_SECONDS,
    origin,
    remuxAudioGrid(basis as never),
  );
  const gopDir = join(work, o.name, 'gop-run');
  mkdirSync(gopDir, { recursive: true });
  const args = buildRemuxArgs(
    {
      inputPath: o.file,
      outputDir: gopDir,
      run,
      trustedStreamInfo: true,
      audioStreamIndex: 0,
      sourceVideoCodec: 'h264',
      audioStreams: Array.from({ length: o.tracks }, (_, i) => ({
        language: 'und',
        streamIndex: i + 1,
      })),
      grid,
      segmentDuration: SEGMENT_SECONDS,
      videoStreamIndex: 0,
      sourceEndSeconds: s.end,
      audioPlan: o.plans[0],
      audioTrackPlans: multi ? o.plans : undefined,
      videoOnly: multi,
    } as unknown as BuildRemuxArgsOptions,
    log,
  );
  execFileSync(join(TOOLS!, 'ffmpeg'), args, {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const input = b64dir(gopDir);
  const plan = remuxAssemblyPlan({
    dir: join(work, o.name),
    gopDir,
    grid,
    startSegment: o.start,
    run,
    origin,
    segmentDuration: SEGMENT_SECONDS,
    audioRenditions: multi ? o.tracks : 0,
  });
  const v: Run = {
    name: o.name,
    source: 'ts',
    fn: 'remuxAssembler',
    scan: s,
    grid,
    run,
    plan: withoutDirs(plan),
    input,
  };
  v.expected = (await replay(v)).expected;
  return v;
}

if (GEN) {
  it('writes fixtures/mp4/assembler', async () => {
    mkdirSync(dir(GEN), { recursive: true });
    let runs: Run[];
    if (TOOLS) {
      const work = mkdtempSync(join(tmpdir(), 'remux-rec-'));
      try {
        const one = clip(work, 'one.mkv', 1);
        const two = clip(work, 'two.mkv', 2);
        const copy = { mode: 'copy', codec: 'aac', channels: 2 } as const;
        const aac = { mode: 'transcode', codec: 'aac', channels: 2 } as const;
        runs = [];
        for (const s of [
          {
            name: 'inline-grid-0',
            file: one,
            tracks: 1,
            start: 0,
            useGrid: true,
            plans: [copy],
          },
          {
            name: 'inline-uniform-1',
            file: one,
            tracks: 1,
            start: 1,
            useGrid: false,
            plans: [copy],
          },
          {
            name: 'multi-grid-0',
            file: two,
            tracks: 2,
            start: 0,
            useGrid: true,
            plans: [copy, copy],
          },
          {
            name: 'multi-grid-seek-1',
            file: two,
            tracks: 2,
            start: 1,
            useGrid: true,
            plans: [copy, copy],
          },
          {
            name: 'multi-encode-seek-1',
            file: two,
            tracks: 2,
            start: 1,
            useGrid: true,
            plans: [aac, copy],
          },
        ] as Scenario[])
          runs.push(await record(work, s));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    } else {
      runs = [];
      for (const v of load(GEN)) {
        const out = await replay(v);
        runs.push({ ...v, plan: out.plan, expected: out.expected });
      }
    }
    expect(runs.length).toBeGreaterThan(0);
    for (const v of runs)
      writeFileSync(join(dir(GEN), `${v.name}.json`), serialise(v));
  }, 300_000);
} else if (CHECK) {
  const runs = load(CHECK);
  describe('remux assembler vectors match the engine checkout', () => {
    it('has fixtures', () => expect(runs.length).toBeGreaterThan(0));
    it.each(runs.map((v) => [v.name, v] as const))('%s', async (_n, v) => {
      const out = await replay(v);
      expect(sortKeys(out.plan)).toEqual(sortKeys(v.plan));
      expect(out.expected).toEqual(v.expected);
    });
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO (with REMUX_TOOLS to re-record) to generate, or FLIKS_ENGINE_REPO_CHECK to verify, remux assembler vectors', () =>
    undefined);
}
