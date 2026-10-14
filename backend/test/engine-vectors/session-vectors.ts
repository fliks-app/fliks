/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- stubs poke private state of the real services */
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TranscodeCacheService } from '../../src/modules/streaming/transcoding/transcode-cache.service';
import { TranscodingService } from '../../src/modules/streaming/transcoding/transcoding.service';
import { RemuxSegmentAssembler } from '../../src/modules/streaming/transcoding/remux-assembler';
import {
  decideThrottle,
  FfmpegThrottleService,
  isThrottleEligible,
  jobPlayheadSeconds,
  runLeadSeconds,
} from '../../src/modules/streaming/transcoding/ffmpeg-throttle.service';
import { setPauseCapabilityForTest } from '../../src/modules/streaming/transcoding/ffmpeg-pause';
import { sessionKey } from '../../src/modules/streaming/transcoding/session-key';
import {
  baseProfileHash,
  remuxVariant,
  variantHash,
  variantSuffix,
  type SessionVariant,
} from '../../src/modules/streaming/transcoding/variant';
import {
  buildLiveSession,
  LiveSessionRegistry,
} from '../../src/modules/streaming/live-session.service';
import { SessionRouter } from '../../src/modules/streaming/services/session-router.service';

/**
 * Golden vectors of the engine's `core::session`: each kind calls the real TS (`fixtures/session`
 * input/expected are in the Rust wire shape, see `docs/spec/session.md`).
 */
export type SessionKind =
  | 'keys'
  | 'resolve-existing'
  | 'throttle-decide'
  | 'run-lead'
  | 'job-playhead'
  | 'throttle-eligible'
  | 'throttle-tick'
  | 'cache-gc'
  | 'job-idle'
  | 'live-gc'
  | 'live-cap'
  | 'sid-gate';

export interface SessionVector {
  name: string;
  source: string;
  kind: SessionKind;
  input: any;
  expected?: unknown;
}

/** One file holding many cases (the synthetic matrices). */
export interface SessionMatrix {
  name: string;
  source: string;
  kind: SessionKind;
  cases: { name: string; input: any; expected?: unknown }[];
}

const J = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const seg = (n: number) => `seg-${String(n).padStart(4, '0')}.m4s`;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `session-vec-${prefix}-`));
}

function writeSegments(dir: string, present: number[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const n of present) fs.writeFileSync(path.join(dir, seg(n)), '');
}

/** A real `RemuxSegmentAssembler` (so `canServe` is the TS's own) with only its progress set. */
function assemblerOf(p: {
  startSegment: number;
  frontier: number | null;
  segmentsPerSecond: number | null;
}): RemuxSegmentAssembler {
  const a = Object.create(RemuxSegmentAssembler.prototype);
  a.plan = { startSegment: p.startSegment };
  a.opened = p.frontier != null;
  a.next = p.frontier ?? 0;
  a.audio = [];
  a.segmentsPerSecond = () => p.segmentsPerSecond;
  return a as RemuxSegmentAssembler;
}

function variantOf(v: any): SessionVariant {
  if (v.kind === 'remux')
    return remuxVariant({
      audioIndex: v.audioIndex ?? undefined,
      keyframeGrid: v.keyframeGrid,
      multiAudio: v.multiAudio,
    });
  return { kind: v.kind };
}

function runKeys(i: any): unknown {
  const v = variantOf(i.variant);
  const hash = variantHash(i.base, v);
  return {
    sessionKey: sessionKey(i.mediaFileId, i.ownerId ?? undefined, hash),
    suffix: variantSuffix(v),
    hash,
    strippedRaw: baseProfileHash(i.raw),
    strippedHash: baseProfileHash(hash),
  };
}

let resolveDir: string | undefined;
async function runResolveExisting(i: any): Promise<unknown> {
  resolveDir ??= tmpDir('resolve');
  const dir = resolveDir;
  writeSegments(dir, i.present);
  const svc = new TranscodingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  let kills = 0;
  (svc as any).killProcess = () => {
    kills++;
    return Promise.resolve();
  };
  const r = i.run;
  const assembler = r.assembler ? assemblerOf(r.assembler) : undefined;
  const session = {
    id: 'k',
    cachePath: dir,
    startSegment: r.startSegment,
    remux: r.remux || undefined,
    remuxAssembler: assembler,
    outputPending: r.outputPending || undefined,
    outputDone: Promise.resolve(),
    process: { exitCode: r.exitCode, signalCode: r.signal ? 'SIGKILL' : null },
  };
  const out = await (svc as any).resolveExistingSession(
    'k',
    session,
    i.requestedSegment,
    i.qualityMatch,
  );
  if (out != null) return { result: 'existing' };
  return {
    result: 'respawn',
    kill: kills > 0,
    startSegment: session.startSegment,
    purgeCache: !fs.existsSync(dir),
  };
}

function runJobPlayhead(i: any): unknown {
  const live = i.viewers.map((v: any) => ({
    position: v.position,
    lastRequestedSegment: v.lastRequestedSegment,
  }));
  const g = i.grid;
  const remux =
    g.kind === 'remux'
      ? { segmentContentSeconds: (n: number) => g.boundaries[n] ?? 0 }
      : null;
  return {
    playhead: jobPlayheadSeconds(
      live,
      g.segmentDuration ?? 3,
      g.fps ?? undefined,
      remux,
    ),
  };
}

let tickDir: string | undefined;
async function runThrottleTick(i: any): Promise<unknown> {
  tickDir ??= tmpDir('tick');
  setPauseCapabilityForTest(i.capability);
  const writes: string[] = [];
  const kills: string[] = [];
  const proc = {
    exitCode: i.processExited ? 0 : null,
    kill: (s: string) => kills.push(s),
    stdin: { write: (s: string) => writes.push(s) },
  };
  const run = i.run;
  let session: any = {
    id: 'run',
    mediaFileId: 1,
    userId: 1,
    baseProfileHash: 'hash',
    variant: i.variant ?? undefined,
    process: proc,
    throttlePaused: i.paused,
  };
  if (run.kind === 'transcode') {
    writeSegments(tickDir, run.present);
    session = {
      ...session,
      cachePath: tickDir,
      startSegment: run.startSegment,
      segmentDuration: run.segmentDuration,
      sourceFps: run.fps ?? undefined,
      throttleFrontierSegment: run.frontierHint ?? undefined,
    };
  } else {
    session.remuxAssembler = {
      runStartSeconds: () => run.startSeconds,
      frontierSeconds: () => run.frontierSeconds,
      segmentContentSeconds: (n: number) => run.boundaries[n] ?? 0,
      pause: () => undefined,
      resume: () => undefined,
    };
  }
  const svc = new FfmpegThrottleService(
    { getActiveSessions: () => [session] } as never,
    {
      listForJob: () =>
        i.viewers.map((v: any) => ({
          position: v.position,
          lastRequestedSegment: v.lastRequestedSegment,
          pinned: v.pinned,
        })),
    } as never,
    {
      get: () =>
        Promise.resolve({
          throttleEnabled: i.enabled,
          throttleThresholdSeconds: i.thresholdSeconds,
        }),
    } as never,
  );
  await (svc as any).tickOnce();
  const sent = [...kills, ...writes];
  const decision = sent.some((s) => s === 'SIGSTOP' || s === 'p')
    ? 'pause'
    : sent.some((s) => s === 'SIGCONT' || s === 'u')
      ? 'resume'
      : 'noop';
  return {
    decision,
    frontierSegment:
      run.kind === 'transcode'
        ? (session.throttleFrontierSegment ?? null)
        : null,
  };
}

let gcRoot: string | undefined;
async function runCacheGc(i: any): Promise<unknown> {
  gcRoot ??= tmpDir('gc');
  fs.rmSync(gcRoot, { recursive: true, force: true });
  fs.mkdirSync(gcRoot, { recursive: true });
  process.env.TRANSCODE_CACHE_ROOT = gcRoot;
  const now = i.nowMs as number;
  const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
  Logger.overrideLogger(false);
  const cache = new TranscodeCacheService();
  try {
    const live = new Set<string>();
    for (const e of i.entries) {
      const dir = cache.cachePathFor(
        e.owner,
        e.mediaFileId,
        e.profile,
        '1080p',
      );
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, seg(0));
      fs.writeFileSync(file, Buffer.alloc(e.totalBytes));
      const t = new Date(e.lastAccessMs);
      fs.utimesSync(file, t, t);
      if (e.live)
        live.add(cache.cachePathFor(e.owner, e.mediaFileId, e.profile));
    }
    cache.setLimits({ ttlMs: i.policy.ttlMs, maxBytes: i.policy.maxBytes });
    cache.registerLiveDirProvider(() => live);
    const evicted: string[] = [];
    const realEvict = cache.evict.bind(cache);
    cache.evict = (entry) => {
      evicted.push(
        `${entry.userId ?? 'anon'}::${entry.mediaFileId}::${entry.profileHash}`,
      );
      return realEvict(entry);
    };
    await cache.runGc();
    return { evicted: evicted.sort() };
  } finally {
    spy.mockRestore();
    cache.onModuleDestroy();
  }
}

function runJobIdle(i: any): unknown {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(i.nowMs);
  try {
    const svc = new TranscodingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    let kills = 0;
    (svc as any).killProcess = () => {
      kills++;
      return Promise.resolve();
    };
    (svc as any).liveSessions = {
      listForJob: () => new Array(i.viewers).fill({}),
    };
    Logger.overrideLogger(false);
    const session: any = {
      id: 'k',
      userId: 1,
      mediaFileId: 1,
      baseProfileHash: i.hasBaseHash ? 'h' : undefined,
      lastAccess: i.lastAccessMs,
      seenAnyLiveSession: i.state.seenAnyViewer,
      zeroLiveSince: i.state.zeroViewersSinceMs,
      process: { exitCode: i.processRunning ? null : 0, signalCode: null },
    };
    (svc as any).sessions.set('k', session);
    (svc as any).cleanupStaleSessions();
    const kept = (svc as any).sessions.has('k');
    return {
      state: {
        seenAnyViewer: !!session.seenAnyLiveSession,
        zeroViewersSinceMs: session.zeroLiveSince ?? null,
      },
      action: kept ? 'keep' : 'reap',
      kill: kills > 0,
    };
  } finally {
    spy.mockRestore();
  }
}

function newRegistry(): LiveSessionRegistry {
  Logger.overrideLogger(false);
  return new LiveSessionRegistry();
}

const liveInput = (pinned = false) => ({
  userId: 1,
  username: 'u',
  mediaFileId: 1,
  kind: 'transcode' as const,
  pinned,
});

function runLiveGc(i: any): unknown {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(i.nowMs);
  try {
    const reg = newRegistry();
    const ids = i.sessions.map((s: any) => {
      const sess = reg.create(liveInput(s.pinned));
      sess.lastBeat = s.lastBeatMs;
      return sess.sessionId;
    });
    (reg as any).runGc();
    const alive = ids.map((id: string) => reg.peek(id) != null);
    const states = ids.map((id: string, n: number) =>
      alive[n] ? 'live' : reg.get(id) != null ? 'revived' : 'gone',
    );
    return { states };
  } finally {
    spy.mockRestore();
  }
}

function runLiveCap(i: any): unknown {
  const reg = newRegistry();
  const ids: string[] = [];
  i.lastBeatsMs.forEach((beat: number, n: number) => {
    const s = buildLiveSession(liveInput(), `s${n}`, 0);
    s.sessionId = `s${n}`;
    s.lastBeat = beat;
    (reg as any).sessions.set(s.sessionId, s);
    ids.push(s.sessionId);
  });
  reg.create(liveInput());
  const gone = ids
    .map((id, n) => (reg.peek(id) == null ? n : -1))
    .filter((n) => n >= 0);
  return { evictedIndex: gone.length ? gone[0] : null };
}

function runSidGate(i: any): unknown {
  const router = new SessionRouter(
    { touch: () => i.known } as never,
    {} as never,
  );
  try {
    router.assertFresh({ query: i.sidPresent ? { sid: 'x' } : {} } as never);
    return { expired: false };
  } catch {
    return { expired: true };
  }
}

export async function runSession(
  kind: SessionKind,
  input: any,
): Promise<unknown> {
  const i = J(input);
  switch (kind) {
    case 'keys':
      return runKeys(i);
    case 'resolve-existing':
      return runResolveExisting(i);
    case 'throttle-decide':
      return {
        decision: decideThrottle({
          aheadSeconds: i.aheadSeconds,
          paused: i.paused,
          thresholdSeconds: i.thresholdSeconds,
        }),
      };
    case 'run-lead':
      return { lead: runLeadSeconds(i.span, i.playhead) };
    case 'job-playhead':
      return runJobPlayhead(i);
    case 'throttle-eligible':
      return {
        eligible: isThrottleEligible(
          i.variant ? i.variant.kind : undefined,
          i.viewers.map((v: any) => ({ pinned: v.pinned })),
        ),
      };
    case 'throttle-tick':
      return runThrottleTick(i);
    case 'cache-gc':
      return runCacheGc(i);
    case 'job-idle':
      return runJobIdle(i);
    case 'live-gc':
      return runLiveGc(i);
    case 'live-cap':
      return runLiveCap(i);
    case 'sid-gate':
      return runSidGate(i);
  }
}

export async function cleanupSession(): Promise<void> {
  for (const d of [resolveDir, tickDir, gcRoot])
    if (d) await fsp.rm(d, { recursive: true, force: true });
  resolveDir = tickDir = gcRoot = undefined;
}
