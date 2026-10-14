/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories need require() */
import { Logger } from '@nestjs/common';
import { computeMovieHash } from '../../src/modules/subtitles/moviehash';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { extname, join } from 'path';
import { VIDEO_EXTS } from '../../src/common/constants/video-extensions';
import { promisify } from 'util';
import { FfprobeService } from '../../src/modules/media-probe/ffprobe.service';
import { resetMkvmergeAvailability } from '../../src/modules/media-probe/mkv-language-tags';
import { moviehashVectors } from './probe-moviehash';
import { fpsVectors, titleVectors } from './probe-text';
import { fuzzCases } from './probe-fuzz';
import { syntheticCases } from './probe-synthetic';
import { io, type Backend, type Call, type ToolResult } from './probe-io';
import { slug, sortKeys } from './vector';

// The service's child_process and stat run against a backend: real tools, canned answers or a recording.
// With PROBE_LIBRARY the real child_process runs the tools found on PATH.
jest.mock('child_process', () =>
  process.env.PROBE_LIBRARY
    ? jest.requireActual<typeof import('child_process')>('child_process')
    : (require('./probe-io') as typeof import('./probe-io')).childProcessMock(
        jest.requireActual('child_process'),
      ),
);
jest.mock('fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('fs/promises')>('fs/promises');
  const state = (require('./probe-io') as typeof import('./probe-io')).io;
  return {
    ...actual,
    stat: (p: string) =>
      state.fileSize === undefined
        ? actual.stat(p)
        : Promise.resolve({ size: state.fileSize }),
  };
});

const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const CORPUS = process.env.PROBE_CORPUS_DIR;
const TOOLS = process.env.PROBE_TOOLS;
const LIBRARY = process.env.PROBE_LIBRARY;
const LIBRARY_OUT = process.env.PROBE_OUT;

export interface Opts {
  crop: boolean;
  mkvTags: boolean;
}

export interface Expected {
  ok: boolean;
  info: unknown;
  error?: string;
  /** Paths the host serialises as `null` (NaN): the engine leaves them absent. */
  nulls: string[];
}

interface Fixture {
  name: string;
  source: 'corpus' | 'synthetic';
  /** Corpus file name, and the host's moviehash of it (null under 128 KiB). */
  file?: string;
  moviehash?: { hash: string; bytesize: number } | null;
  fileSize: number;
  opts: Opts;
  calls: Call[];
  expected: Expected;
}

const PATH = '{path}';

// The host runs on a platform without GPU crop decode: software decode, the engine's only mode.
Object.defineProperty(process, 'platform', { value: 'freebsd' });

/** What the rescan does for one file: the probe, then `detectCrop` on the first video stream. */
async function runService(path: string, opts: Opts) {
  const svc = new FfprobeService();
  const info = await svc.detectMediaFileInfo(path);
  const v = info.video?.[0];
  if (opts.crop && v) {
    const crop = await svc.detectCrop(
      path,
      info.durationSeconds,
      v.width,
      v.height,
    );
    if (crop) v.crop = crop;
  }
  return info;
}

function collectNulls(x: unknown, at: string, out: string[]): unknown {
  if (Array.isArray(x))
    return x.map((e, i) => collectNulls(e, `${at}[${i}]`, out));
  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.entries(x).flatMap(([k, v]) => {
        if (v === null) {
          out.push(`${at}.${k}`);
          return [];
        }
        return [[k, collectNulls(v, `${at}.${k}`, out)]];
      }),
    );
  }
  return x;
}

function expectedOf(info: unknown, calls: Call[], path: string): Expected {
  const nulls: string[] = [];
  const text = JSON.stringify(info).split(path).join(PATH);
  const clean = sortKeys(collectNulls(JSON.parse(text), '', nulls)) as {
    error?: string;
  };
  const ok = calls[0]?.fail === undefined;
  return { ok, info: clean, ...(ok ? {} : { error: clean.error }), nulls };
}

/** Stable order: the service's own sequence, with concurrent crop samples by position. */
function rank(c: Call): number {
  const a = c.args.join(' ');
  if (c.cmd === 'mkvmerge') return 5;
  if (c.cmd === 'ffmpeg') return 6;
  if (a.includes('-show_chapters')) return 0;
  if (a.includes('-read_intervals')) return 1;
  if (a.includes('frame=')) return 2;
  if (a.includes('packet=stream_index')) return 3;
  return 4;
}
const ssOf = (c: Call) => Number(c.args[c.args.indexOf('-ss') + 1] ?? 0);

/** The raw output the service consumed, reduced to what it reads and made machine independent. */
function reduce(c: Call, path: string): Call {
  const norm = (s: string) => s.split(path).join(PATH);
  const out: Call = {
    cmd: c.cmd,
    args: c.args.map(norm),
    stdout: norm(c.stdout),
    stderr: norm(c.stderr),
  };
  if (c.fail) out.fail = c.fail;
  if (c.stopped) out.stopped = true;
  if (c.cmd === 'ffmpeg' && !c.fail) {
    // Only the last `crop=` line is read.
    const last = c.stderr
      .split('\n')
      .reverse()
      .find((l) => /crop=\d+:\d+:\d+:\d+/.test(l));
    out.stderr = (last ?? '').replace(/@ 0x[0-9a-f]+/g, '@ 0x0');
  } else if (c.cmd === 'mkvmerge' && c.stdout) {
    try {
      const j = JSON.parse(c.stdout) as {
        tracks?: {
          id: number;
          type: string;
          properties?: Record<string, unknown>;
        }[];
      };
      out.stdout = JSON.stringify({
        tracks: (j.tracks ?? []).map((t) => ({
          id: t.id,
          type: t.type,
          properties: {
            language: t.properties?.language,
            language_ietf: t.properties?.language_ietf,
          },
        })),
      });
    } catch {
      // Not JSON: keep as is.
    }
  } else if (
    c.cmd === 'ffprobe' &&
    c.stdout.startsWith('{') &&
    !c.args.some((a) => a.startsWith('frame='))
  ) {
    try {
      out.stdout = JSON.stringify(JSON.parse(norm(c.stdout)));
    } catch {
      // Keep as is.
    }
  }
  return out;
}

/** Replays a fixture's recorded calls through the real service. */
async function replay(f: Fixture): Promise<Expected> {
  const path = `/replay/${f.name}`;
  const key = (cmd: string, args: string[]) =>
    `${cmd}\0${JSON.stringify(args)}`;
  const sub = (s: string) => s.split(PATH).join(path);
  const queues = new Map<string, Call[]>();
  for (const c of f.calls) {
    const k = key(c.cmd, c.args.map(sub));
    queues.set(k, [...(queues.get(k) ?? []), c]);
  }
  const unmatched: string[] = [];
  io.backend = (cmd, args) => {
    const c = queues.get(key(cmd, args))?.shift();
    if (!c) {
      unmatched.push(`${cmd} ${args.join(' ')}`);
      return Promise.resolve({
        stdout: '',
        stderr: 'no recorded call',
        fail: { code: 1 },
      });
    }
    return Promise.resolve({
      stdout: sub(c.stdout),
      stderr: sub(c.stderr),
      fail: c.fail,
    });
  };
  io.fileSize = f.fileSize;
  io.log = [];
  resetMkvmergeAvailability();
  const info = await runService(path, f.opts);
  const left = [...queues.values()].flat().length;
  if (unmatched.length || left)
    throw new Error(
      `${f.name}: unmatched calls ${JSON.stringify(unmatched)}, unused ${left}`,
    );
  return expectedOf(info, io.log, path);
}

function realBackend(): Backend {
  const run = promisify(
    jest.requireActual<typeof import('child_process')>('child_process')
      .execFile,
  );
  return async (cmd, args) => {
    try {
      const { stdout, stderr } = await run(join(TOOLS!, cmd), args, {
        maxBuffer: 1 << 28,
      });
      return { stdout, stderr };
    } catch (e) {
      const err = e as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const r: ToolResult = {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        fail: { code: typeof err.code === 'number' ? err.code : 1 },
      };
      return r;
    }
  };
}

/** Records one file: the calls the service issues and what the real tools answer. */
async function capture(
  name: string,
  path: string,
  backend: Backend,
  fileSize: number | undefined,
  opts: Opts,
): Promise<Fixture> {
  io.backend = backend;
  io.log = [];
  io.fileSize = fileSize as number;
  resetMkvmergeAvailability();
  const info = await runService(path, opts);
  const calls = io.log
    .map((c) => reduce(c, path))
    .sort((a, b) => rank(a) - rank(b) || ssOf(a) - ssOf(b));
  const f: Fixture = {
    name,
    source: fileSize === undefined ? 'corpus' : 'synthetic',
    fileSize: fileSize ?? statSync(path).size,
    opts,
    calls,
    expected: expectedOf(info, io.log, path),
  };
  if (fileSize === undefined) {
    f.file = path.split('/').pop();
    f.moviehash = await computeMovieHash(path);
  }
  const again = await replay(f);
  if (JSON.stringify(again) !== JSON.stringify(f.expected))
    throw new Error(`${name}: replay differs from the live run`);
  return f;
}

const dir = (repo: string) => join(repo, 'fixtures', 'probe');
const json = (x: unknown) => JSON.stringify(sortKeys(x), null, 2) + '\n';

function readFixtures(repo: string): Fixture[] {
  const d = dir(repo);
  return existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Fixture)
    : [];
}

Logger.overrideLogger(false);

function* videoFiles(d: string): Generator<string> {
  for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(d, e.name);
    if (e.isDirectory()) yield* videoFiles(p);
    else if (VIDEO_EXTS.has(extname(e.name).toLowerCase())) yield p;
  }
}

if (LIBRARY && LIBRARY_OUT) {
  // Differential run on a real library (read-only), tools from PATH (PATH=$(tools/probe-tools.sh):$PATH):
  // one NDJSON line per video file, never committed.
  it('probes PROBE_LIBRARY into PROBE_OUT', async () => {
    writeFileSync(LIBRARY_OUT, '');
    let total = 0;
    for (const path of videoFiles(LIBRARY)) {
      resetMkvmergeAvailability();
      const t0 = Date.now();
      const info = await runService(path, { crop: true, mkvTags: true });
      const moviehash = await computeMovieHash(path);
      const ms = Date.now() - t0;
      total += ms;
      appendFileSync(
        LIBRARY_OUT,
        JSON.stringify({ path, info, moviehash, ms }) + '\n',
      );
    }
    console.log(`library probe: ${total} ms`);
  }, 3_600_000);
} else if (GEN) {
  it('writes fixtures/probe', async () => {
    const d = dir(GEN);
    mkdirSync(d, { recursive: true });
    const fixtures: Fixture[] = [];
    if (CORPUS && TOOLS) {
      for (const file of readdirSync(CORPUS).sort()) {
        const path = join(CORPUS, file);
        fixtures.push(
          await capture(slug(file), path, realBackend(), undefined, {
            crop: true,
            mkvTags: true,
          }),
        );
      }
    } else {
      // No corpus here: keep the recorded corpus calls and recompute `expected` from them.
      for (const f of readFixtures(GEN).filter((x) => x.source === 'corpus'))
        fixtures.push({ ...f, expected: await replay(f) });
    }
    for (const c of [
      ...syntheticCases(),
      ...fuzzCases(
        Number(process.env.PROBE_FUZZ_SEED ?? 1),
        Number(process.env.PROBE_FUZZ_COUNT ?? 150),
      ),
    ])
      fixtures.push(
        await capture(
          slug(c.name),
          `/synthetic/${slug(c.name)}`,
          c.backend,
          c.fileSize,
          c.opts,
        ),
      );
    for (const f of readdirSync(d)) if (f.endsWith('.json')) rmSync(join(d, f));
    const names = new Set<string>();
    for (const f of fixtures) {
      if (names.has(f.name)) throw new Error(`duplicate fixture ${f.name}`);
      names.add(f.name);
      writeFileSync(join(d, `${f.name}.json`), json(f));
    }
    writeFileSync(join(d, '_moviehash.json'), json(await moviehashVectors()));
    writeFileSync(join(d, '_titles.json'), json(titleVectors()));
    writeFileSync(join(d, '_fps.json'), json(fpsVectors()));
    console.log(`probe fixtures: ${fixtures.length}`);
  }, 600_000);
} else if (CHECK) {
  const fixtures = readFixtures(CHECK);
  describe('probe vectors match the engine checkout', () => {
    it('has fixtures', () => expect(fixtures.length).toBeGreaterThan(0));
    it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
      expect(await replay(f)).toEqual(f.expected);
    });
    it('moviehash, titles and fps vectors', async () => {
      const read = (n: string) =>
        JSON.parse(readFileSync(join(dir(CHECK), n), 'utf8')) as unknown;
      expect(sortKeys(await moviehashVectors())).toEqual(
        read('_moviehash.json'),
      );
      expect(sortKeys(titleVectors())).toEqual(read('_titles.json'));
      expect(sortKeys(fpsVectors())).toEqual(read('_fps.json'));
    });
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO (with PROBE_CORPUS_DIR and PROBE_TOOLS to re-record) to generate, or FLIKS_ENGINE_REPO_CHECK to verify, probe vectors', () =>
    undefined);
}
