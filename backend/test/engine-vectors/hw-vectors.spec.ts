/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- jest.doMock factories and per-run module isolation need require() */
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import { join, sep } from 'path';
import { promisify } from 'util';
import {
  model,
  SYNTHETIC,
  type Call,
  type DrmDevice,
  type Env,
  type PauseModel,
} from './hw-scenarios';
import { sortKeys } from './vector';

/**
 * Host capability detection vectors for the engine's `core::hw`.
 *
 * The real `TranscodingService.onModuleInit` (plus the pause probe) runs against a mocked
 * `child_process` and `fs`; each fixture stores what ffmpeg and sysfs answered (`calls`, `env`),
 * and `expected` is the state the TS ends up in, in the shape of the engine's `Capabilities` and
 * `HostCaps`.
 *
 *   FLIKS_ENGINE_REPO=<engine>        rewrite fixtures/hw (synthetic ones from the model,
 *                                     recorded ones re-derived from their stored calls)
 *   FLIKS_HW_RECORD=<name> (with the above) record that `recorded` scenario on this machine only
 *   FLIKS_ENGINE_REPO_CHECK=<engine>  replay every fixture and compare with `expected`
 *   FLIKS_HW_LIVE=<out.json>          run the real detection with the real ffmpeg and sysfs
 */

const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const LIVE = process.env.FLIKS_HW_LIVE;
const RECORD = process.env.FLIKS_HW_RECORD;

const T = '../../src/modules/streaming/transcoding';

const PROBES: [string, string, string][] = [
  ['tonemapOpencl', 'codec/tonemap-opencl-probe', 'isTonemapOpenclEnabled'],
  [
    'tonemapOpenclCrop',
    'codec/tonemap-opencl-probe',
    'isTonemapOpenclEnabledWithCrop',
  ],
  [
    'tonemapOpenclHdr10',
    'codec/tonemap-opencl-probe',
    'isTonemapOpenclHdr10Enabled',
  ],
  ['qsvOpencl', 'codec/qsv-opencl-probe', 'isQsvOpenclTonemapEnabled'],
  [
    'qsvOpenclHdr10',
    'codec/qsv-opencl-probe',
    'isQsvOpenclTonemapHdr10Enabled',
  ],
  ['vppQsv', 'codec/vpp-qsv-probe', 'isVppQsvTonemapEnabled'],
  ['vulkan', 'codec/vulkan-tonemap-probe', 'isVulkanTonemapEnabled'],
  ['cuda', 'codec/cuda-tonemap-probe', 'isCudaTonemapEnabled'],
  ['cudaHdr10', 'codec/cuda-tonemap-probe', 'isCudaTonemapHdr10Enabled'],
  ['opencl', 'codec/opencl-tonemap-probe', 'isOpenclTonemapEnabled'],
  ['openclHdr10', 'codec/opencl-tonemap-probe', 'isOpenclTonemapHdr10Enabled'],
  ['amfOpencl', 'codec/amf-opencl-probe', 'isAmfOpenclEnabled'],
];

type Answer = { exit: number; stderr: string; stdout?: string };
type Source = (args: string[], timeoutMs: number) => Promise<Answer>;

/** Spawn/exec arguments carry per-process temp paths; the fixture keeps placeholders. */
function norm(a: string): string {
  return a
    .replace(os.tmpdir() + sep, '{tmp}/')
    .replace(`-${process.pid}.`, '-{pid}.');
}
const key = (args: string[]) => JSON.stringify(args.map(norm));

interface Result {
  capabilities: unknown;
  hostCaps: unknown;
  commands: { args: string[]; timeoutMs: number }[];
  calls: Call[];
  pauseSamples: number[] | null;
}

function fakePause(kind: PauseModel, samples: { v: number[] | null }) {
  return () => {
    if (kind === 'spawn-fails') throw new Error('spawn ffmpeg ENOENT');
    const proc: any = new EventEmitter();
    let frames = 0;
    let paused = false;
    const tick = setInterval(() => {
      if (paused) return;
      frames++;
      proc.stderr.emit('data', Buffer.from(`frame=${frames}\n`));
    }, 33);
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.write = (k: string) => {
      if (k === 'p') {
        if (kind === 'pausable') paused = true;
        // The TS reads `frames` 1.5 s, 3 s and (after `u` at 3 s) 4 s after `p`.
        const snap: number[] = [];
        for (const ms of [1500, 3000, 4000])
          setTimeout(() => {
            snap.push(frames);
            if (snap.length === 3) samples.v = snap;
          }, ms);
      }
      if (k === 'u' && kind === 'pausable') paused = false;
      return true;
    };
    proc.kill = () => {
      clearInterval(tick);
      return true;
    };
    return proc;
  };
}

/** Runs the TS detection once against `source`; modules are fresh so boot state never leaks. */
async function runTs(
  env: Env,
  source: Source | null,
  pause: PauseModel | null,
  mockFs: boolean,
): Promise<Result> {
  const calls = new Map<string, Call>();
  let phase: 'boot' | 'repin' = 'boot';
  const phaseOf = new Map<string, Set<string>>();
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const samples: { v: number[] | null } = { v: null };
  let result!: Result;

  const exec = async (file: string, args: string[], opts: any) => {
    expect(file).toBe('ffmpeg');
    const timeoutMs = opts?.timeout ?? 0;
    let a: Answer;
    if (source) a = await source(args, timeoutMs);
    else {
      const real = promisify(
        jest.requireActual<typeof import('child_process')>('child_process')
          .execFile,
      );
      try {
        const r = await real(file, args, opts);
        a = { exit: 0, stderr: String(r.stderr), stdout: String(r.stdout) };
      } catch (e: any) {
        a = {
          exit: typeof e.code === 'number' ? e.code : -1,
          stderr: String(e.stderr ?? ''),
          stdout: String(e.stdout ?? ''),
        };
      }
    }
    const k = key(args);
    const isEncoders = args.includes('-encoders');
    const isVerbose = args.includes('verbose');
    const c: Call = {
      args: args.map(norm),
      timeoutMs,
      exit: a.exit,
      stderr: a.exit !== 0 || isVerbose ? a.stderr : '',
    };
    if (isEncoders) c.stdout = a.stdout ?? '';
    calls.set(k, c);
    (phaseOf.get(phase) ?? phaseOf.set(phase, new Set()).get(phase)!).add(k);
    if (a.exit !== 0)
      throw Object.assign(new Error('Command failed'), {
        code: a.exit,
        stderr: a.stderr,
        stdout: a.stdout ?? '',
      });
    return { stdout: a.stdout ?? '', stderr: a.stderr };
  };

  await jest.isolateModulesAsync(async () => {
    jest.doMock('child_process', () => {
      const actual =
        jest.requireActual<typeof import('child_process')>('child_process');
      const execFile: any = () => {
        throw new Error('callback execFile is not mocked');
      };
      execFile[promisify.custom] = exec;
      return {
        ...actual,
        execFile,
        spawn: pause ? fakePause(pause, samples) : actual.spawn,
      };
    });
    if (mockFs) {
      jest.doMock('fs', () => {
        const actual = jest.requireActual<typeof import('fs')>('fs');
        const enoent = (p: string) =>
          Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        const dev = (p: string) => /renderD\d+/.exec(p)?.[0] ?? '';
        return {
          ...actual,
          readdirSync: (p: any, ...r: any[]) => {
            const s = String(p);
            if (s === '/dev/dri') {
              if (!env.driEntries) throw enoent(s);
              return [...env.driEntries];
            }
            const m = /^\/sys\/class\/drm\/(renderD\d+)\/device\/drm$/.exec(s);
            if (m) {
              const d = env.drm[m[1]];
              if (!d) throw enoent(s);
              return [...d.drmEntries];
            }
            return (actual.readdirSync as any)(p, ...r);
          },
          readFileSync: (p: any, ...r: any[]) => {
            const s = String(p);
            const m =
              /^\/sys\/class\/drm\/(renderD\d+)\/device\/(vendor|device|boot_vga)$/.exec(
                s,
              );
            if (m) {
              const d = env.drm[m[1]];
              const v =
                d?.[
                  m[2] === 'boot_vga'
                    ? 'bootVga'
                    : (m[2] as 'vendor' | 'device')
                ];
              if (v == null) throw enoent(s);
              return `${v}\n`;
            }
            return (actual.readFileSync as any)(p, ...r);
          },
          realpathSync: (p: any, ...r: any[]) => {
            const s = String(p);
            if (s.startsWith('/sys/class/drm/')) {
              const d = env.drm[dev(s)];
              if (!d) throw enoent(s);
              return d.realpath;
            }
            return (actual.realpathSync as any)(p, ...r);
          },
        };
      });
    }

    Object.defineProperty(process, 'platform', {
      ...savedPlatform,
      value: env.platform,
    });
    try {
      const { TranscodingService } = require(`${T}/transcoding.service`);
      const encoders = require(`${T}/codec/encoders`);
      const decoders = require(`${T}/codec/decoders`);
      const encProbe = require(`${T}/codec/encoder-probe`);
      const decProbe = require(`${T}/codec/decoder-probe`);
      const audio = require(`${T}/audio-encoder-probe`);
      const pauseMod = require(`${T}/ffmpeg-pause`);
      require('@nestjs/common').Logger.overrideLogger(false);
      const log = new Logger('hw-vectors');

      const settings = (gpuRenderNode: string) => ({
        gpuRenderNode,
        ffmpegSlots: null,
        cacheTtlMs: 1,
        cacheMaxBytes: 1,
      });
      const svc = new TranscodingService(
        {
          registerLiveDirProvider: () => undefined,
          setLimits: () => undefined,
        },
        {},
        { get: () => Promise.resolve(settings('auto')) },
        {},
      );
      const settle = async () => {
        while (svc.probeChainRunning || svc.probeChainRerun)
          await new Promise((r) => setTimeout(r, 5));
      };
      await svc.onModuleInit();
      await settle();
      if (env.gpuRenderNode !== 'auto') {
        phase = 'repin';
        svc.applyStreamingSettings(settings(env.gpuRenderNode));
        await settle();
      }
      await svc.onModuleDestroy();

      if (pause) {
        jest.useFakeTimers();
        const p = pauseMod.detectPauseCapability(log);
        await jest.advanceTimersByTimeAsync(13_000);
        await p;
        jest.useRealTimers();
      } else {
        await pauseMod.detectPauseCapability(log);
      }

      const id = (d: { id: string }) => d.id;
      const encAll: { id: string }[] = [...encoders.ALL_DESCRIPTORS];
      const decAll: { id: string }[] = [...decoders.ALL_DECODERS];
      const hwAccel = svc.getDetectedHwAccel();
      const { gpus, defaultNode } = svc.getGpus();
      const hostCaps = {
        hwAccel,
        platform: env.platform,
        libfdkAac: audio.isLibfdkAacEnabled(),
        vaapiWritesHdrMetadata: encProbe.vaapiWritesHdrMetadata(),
        probes: PROBES.filter(([, mod, fn]) =>
          require(`${T}/${mod}`)[fn](),
        ).map(([n]) => n),
        disabledEncoders: encAll
          .filter((d) => !encProbe.isEncoderEnabled(d.id))
          .map(id),
        disabledDecoders: decAll
          .filter((d) => !decProbe.isDecoderEnabled(d.id))
          .map(id),
      };
      const capabilities = {
        hwAccel,
        encoders: encAll.filter((d) => encProbe.isEncoderEnabled(d.id)).map(id),
        decoders: decAll.filter((d) => decProbe.isDecoderEnabled(d.id)).map(id),
        tonemapAlgos: svc.getAvailableTonemapAlgos(),
        gpus: gpus.map((g: any) => ({
          renderNode: g.renderNode,
          name: g.label,
        })),
        defaultGpu: gpus.length > 0 ? defaultNode : null,
        platform: env.platform,
        pauseCapability: pauseMod.getPauseCapability(),
      };
      // A re-pin re-runs everything but the libfdk listing: count it for the equivalent single run.
      const last = new Set(phaseOf.get(phase) ?? []);
      for (const k of phaseOf.get('boot') ?? [])
        if (k.includes('"-encoders"')) last.add(k);
      result = {
        capabilities,
        hostCaps,
        commands: [...last]
          .map((k) => calls.get(k)!)
          .map((c) => ({ args: c.args, timeoutMs: c.timeoutMs }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        calls: [...calls.values()],
        pauseSamples: samples.v,
      };
    } finally {
      jest.useRealTimers();
      Object.defineProperty(process, 'platform', savedPlatform);
      jest.dontMock('child_process');
      jest.dontMock('fs');
    }
  });
  return result;
}

/** What ffmpeg answered, looked up by argv; an unrecorded argv is a drift in the TS probes. */
function replay(calls: Call[]): Source {
  const by = new Map(calls.map((c) => [JSON.stringify(c.args), c]));
  return (args) => {
    const c = by.get(JSON.stringify(args.map(norm)));
    if (!c)
      throw new Error(
        `no recorded call for ffmpeg ${args.map(norm).join(' ')}`,
      );
    return Promise.resolve({
      exit: c.exit,
      stderr: c.stderr,
      stdout: c.stdout,
    });
  };
}

interface Fixture {
  name: string;
  source: 'recorded' | 'synthetic';
  note: string;
  env: Env;
  calls: Call[];
  pause: { model: PauseModel; samples: number[] | null };
  expected: {
    capabilities: unknown;
    hostCaps: unknown;
    commands: { args: string[]; timeoutMs: number }[];
  };
}

const dir = (repo: string) => join(repo, 'fixtures', 'hw');
const write = (repo: string, f: Fixture) => {
  mkdirSync(dir(repo), { recursive: true });
  writeFileSync(
    join(dir(repo), `${f.name}.json`),
    JSON.stringify(sortKeys(f), null, 2) + '\n',
  );
};

/** The sysfs and /dev/dri state of the machine running the test. */
function liveEnv(gpuRenderNode: string): Env {
  let driEntries: string[] | null = null;
  const drm: Record<string, DrmDevice> = {};
  try {
    driEntries = fs.readdirSync('/dev/dri').sort();
  } catch {
    /* no DRI */
  }
  const read = (p: string) => {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return null;
    }
  };
  for (const n of driEntries ?? []) {
    if (!/^renderD\d+$/.test(n)) continue;
    const sys = `/sys/class/drm/${n}/device`;
    let drmEntries: string[] = [];
    try {
      drmEntries = fs.readdirSync(`${sys}/drm`);
    } catch {
      /* none */
    }
    drm[n] = {
      vendor: read(`${sys}/vendor`),
      device: read(`${sys}/device`),
      bootVga: read(`${sys}/boot_vga`),
      realpath: fs.realpathSync(sys),
      drmEntries,
    };
  }
  return {
    platform: process.platform as Env['platform'],
    gpuRenderNode,
    driEntries,
    drm,
  };
}

Logger.overrideLogger(false);

const RECORDED: { name: string; note: string; node: string }[] = [
  {
    name: 'host-ffmpeg-no-driver',
    note: 'Raptor Lake iGPU + Arc A370M, Ubuntu ffmpeg 8.0.1 without the Intel VA driver: every hardware test really fails, both GPUs are listed.',
    node: 'auto',
  },
  {
    name: 'jellyfin-raptor-lake',
    note: 'Same host, jellyfin-ffmpeg 8.1.2 in the engine image with /dev/dri: QSV and VAAPI are real on the iGPU (renderD128).',
    node: 'auto',
  },
  {
    name: 'jellyfin-arc-pinned',
    note: 'Same image, boot on auto then re-pinned to the Arc A370M (renderD129). One run: which HW decoders pass changes from run to run on this GPU.',
    node: '/dev/dri/renderD129',
  },
];

async function generate(repo: string) {
  const out: Fixture[] = [];
  for (const s of SYNTHETIC) {
    const first = await runTs(
      s.env,
      (a) => Promise.resolve(model(s.machine!)(a)),
      s.pause,
      true,
    );
    const again = await runTs(s.env, replay(first.calls), s.pause, true);
    expect(again.hostCaps).toEqual(first.hostCaps);
    out.push({
      name: s.name,
      source: 'synthetic',
      note: s.note,
      env: s.env,
      calls: first.calls,
      pause: { model: s.pause, samples: first.pauseSamples },
      expected: {
        capabilities: again.capabilities,
        hostCaps: again.hostCaps,
        commands: again.commands,
      },
    });
  }
  for (const r of RECORDED) {
    const file = join(dir(repo), `${r.name}.json`);
    let env: Env;
    let calls: Call[];
    if (RECORD === r.name) {
      env = liveEnv(r.node);
      calls = (await runTs(env, null, 'pausable', false)).calls;
    } else if (existsSync(file)) {
      ({ env, calls } = JSON.parse(readFileSync(file, 'utf8')) as Fixture);
    } else continue;
    const res = await runTs(env, replay(calls), 'pausable', true);
    out.push({
      name: r.name,
      source: 'recorded',
      note: r.note,
      env,
      calls,
      pause: { model: 'pausable', samples: res.pauseSamples },
      expected: {
        capabilities: res.capabilities,
        hostCaps: res.hostCaps,
        commands: res.commands,
      },
    });
  }
  return out;
}

if (LIVE) {
  it('runs the TS detection for real and writes the state to FLIKS_HW_LIVE', async () => {
    const node = process.env.FLIKS_HW_NODE ?? 'auto';
    const res = await runTs(liveEnv(node), null, null, false);
    writeFileSync(
      LIVE,
      JSON.stringify(
        sortKeys({ capabilities: res.capabilities, hostCaps: res.hostCaps }),
        null,
        2,
      ) + '\n',
    );
    const calls = res.calls.filter((c) => c.exit !== 0).length;
    console.log(`live: ${res.calls.length} distinct calls, ${calls} failed`);
  }, 300_000);
} else if (GEN) {
  it('writes fixtures/hw', async () => {
    const all = await generate(GEN);
    // A recording run writes its own scenario only.
    if (!RECORD && existsSync(dir(GEN)))
      for (const f of readdirSync(dir(GEN)))
        if (f.endsWith('.json') && !all.some((x) => `${x.name}.json` === f))
          rmSync(join(dir(GEN), f));
    for (const f of all) if (!RECORD || f.name === RECORD) write(GEN, f);
    console.log(`hw vectors: ${all.length}`);
    expect(all.length).toBeGreaterThan(0);
  }, 600_000);
} else if (CHECK) {
  const d = dir(CHECK);
  const files = existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  describe('hw vectors match the engine checkout', () => {
    it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
    it.each(files)(
      '%s',
      async (f) => {
        const v = JSON.parse(readFileSync(join(d, f), 'utf8')) as Fixture;
        const r = await runTs(v.env, replay(v.calls), v.pause.model, true);
        expect(
          sortKeys({
            capabilities: r.capabilities,
            hostCaps: r.hostCaps,
            commands: r.commands,
          }),
        ).toEqual(sortKeys(v.expected));
      },
      60_000,
    );
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO to generate, FLIKS_ENGINE_REPO_CHECK to verify, or FLIKS_HW_LIVE to run for real', () =>
    undefined);
}
