import { ConflictException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import type { User } from '../../users/entities/user.entity';
import type { LiveTvChannel } from '../entities/livetv-channel.entity';
import type { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
  execFile: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn, execFile } = require('child_process') as {
  spawn: jest.Mock;
  execFile: jest.Mock;
};

import axios from 'axios';
jest.mock('axios');
const mockedAxiosGet = axios.get as jest.Mock;

/** ffprobe answering with a given video codec, in its csv=p=0 shape: one line
 *  per stream, then the container. */
function mockProbe(video: string | null, audio = 'aac', container = 'mpegts'): void {
  execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
      if (!video) {
        cb(new Error('probe failed'), '');
        return;
      }
      cb(null, `${video},video\n${audio},audio\n${container}\n`);
    },
  );
}

import { LiveTvSessionService } from './livetv-session.service';
import { LiveTvCapacityService } from './livetv-capacity.service';

class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  stderr = new EventEmitter();
  kill = jest.fn(() => {
    this.exitCode = 137;
    setImmediate(() => this.emit('exit', null));
    return true;
  });
}

function makeUser(id = 1): User {
  return { id } as User;
}

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Test source',
    maxStreams: 0,
    userAgent: null,
    referer: null,
    ...overrides,
  };
}

function makeStream(overrides: Record<string, unknown> = {}): LiveTvChannelStream {
  const source = (overrides.source as ReturnType<typeof makeSource>) ?? makeSource();
  return {
    id: 1,
    channelId: 1,
    sourceId: source.id,
    priority: 0,
    url: 'http://provider.example/1.ts',
    source,
    ...overrides,
  } as unknown as LiveTvChannelStream;
}

function makeChannel(
  streams: LiveTvChannelStream[],
  overrides: Record<string, unknown> = {},
): LiveTvChannel {
  return { id: 1, name: 'Channel 1', streams, ...overrides } as unknown as LiveTvChannel;
}

/** Every spawned ffmpeg immediately "produces" a first segment. */
function mockSpawnAlwaysSucceeds(): FakeProc[] {
  const procs: FakeProc[] = [];
  spawn.mockImplementation((_cmd: string, args: string[]) => {
    const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
    fs.mkdirSync(dir, { recursive: true });
    setImmediate(() => fs.writeFileSync(path.join(dir, 'seg-00000.m4s'), 'x'));
    const proc = new FakeProc();
    procs.push(proc);
    return proc as unknown as ReturnType<typeof spawn>;
  });
  return procs;
}

describe('LiveTvSessionService', () => {
  let service: LiveTvSessionService;
  let channelRepo: { update: jest.Mock; createQueryBuilder: jest.Mock };
  let streamRepo: { update: jest.Mock };
  let settings: { get: jest.Mock };
  let activity: { upsertRunning: jest.Mock; remove: jest.Mock };
  let transcoding: { getDetectedHwAccel: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockProbe('h264');
    mockedAxiosGet.mockReset();
    channelRepo = {
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      })),
    };
    streamRepo = { update: jest.fn() };
    settings = { get: jest.fn().mockResolvedValue(null) };
    activity = { upsertRunning: jest.fn(), remove: jest.fn() };
    transcoding = { getDetectedHwAccel: jest.fn().mockReturnValue('none') };
    service = new LiveTvSessionService(
      channelRepo as never,
      streamRepo as never,
      settings as never,
      activity as never,
      transcoding as never,
      new LiveTvCapacityService(),
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('drops a viewer that stopped fetching, and keeps the ones still watching', async () => {
    mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream()]);

    const gone = await service.open(channel, makeUser(1), {});
    const staying = await service.open(channel, makeUser(2), {});

    // Only the second viewer keeps fetching; the first is a killed tab that
    // never calls leave().
    service.getForServe(staying.sessionId);
    const stale = Date.now() - 10 * 60 * 1000;
    const entry = service.listForActivity().find((r) => r.sessionId === gone.sessionId);
    expect(entry).toBeDefined();
    (service as never as { sessions: Map<string, { viewers: Map<string, { lastSeenAt: number }> }> })
      .sessions.forEach((session) => {
        const viewer = session.viewers.get(gone.sessionId);
        if (viewer) viewer.lastSeenAt = stale;
      });

    (service as never as { sweepAbandoned: () => void }).sweepAbandoned();

    const rows = service.listForActivity();
    expect(rows.map((r) => r.sessionId)).toEqual([staying.sessionId]);
    expect(service.getForServe(gone.sessionId)).toBeUndefined();
    expect(service.getForServe(staying.sessionId)).toBeDefined();
  });

  it('reuses the session for a second viewer, no second ffmpeg', async () => {
    mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream()]);

    const first = await service.open(channel, makeUser(1), {});
    const second = await service.open(channel, makeUser(2), {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.channelId).toBe(first.channelId);
    expect(activity.upsertRunning).toHaveBeenLastCalledWith(
      expect.any(String),
      'livetv.viewing',
      expect.any(Object),
      2,
    );
  });

  it('waits on an in-flight opening attempt rather than handing back a session not yet confirmed', async () => {
    // `openNewSession` registers into `sessions` before its own `recover()` settles,
    // so a caller landing between those two must still resolve from `opening`,
    // not from the placeholder entry `sessions` already carries for the same key.
    const svc = service as unknown as {
      sessions: Map<string, unknown>;
      opening: Map<string, Promise<unknown>>;
      acquireSession(
        key: string,
        channel: unknown,
        streams: unknown[],
        mode: string,
        caps: unknown,
      ): Promise<unknown>;
    };
    const key = 'race-key';
    let resolveOpening!: (v: unknown) => void;
    svc.opening.set(
      key,
      new Promise((resolve) => {
        resolveOpening = resolve;
      }),
    );
    svc.sessions.set(key, { placeholder: true });

    const result = svc.acquireSession(key, {}, [], 'remux', {});
    resolveOpening({ real: true });

    await expect(result).resolves.toEqual({ real: true });
  });

  it('coalesces two concurrent opens on the same key into one session, one ffmpeg', async () => {
    mockSpawnAlwaysSucceeds();
    // Distinct id: isolates this test's transcode dir from its neighbours.
    const channel = makeChannel([makeStream({ id: 101, channelId: 101 })], { id: 101 });

    const [first, second] = await Promise.all([
      service.open(channel, makeUser(1), {}),
      service.open(channel, makeUser(2), {}),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(first.sessionId).not.toBe(second.sessionId);
    const sessionA = service.getForServe(first.sessionId);
    const sessionB = service.getForServe(second.sessionId);
    expect(sessionA).toBe(sessionB);
    expect(sessionA?.viewers.size).toBe(2);
  });

  it('leaves no orphan session when two opens race: every spawned process gets killed', async () => {
    settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'livetv_channel_idle_seconds' ? '0' : null),
    );
    const procs = mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream({ id: 102, channelId: 102 })], { id: 102 });

    const [first, second] = await Promise.all([
      service.open(channel, makeUser(1), {}),
      service.open(channel, makeUser(2), {}),
    ]);
    await service.leave(first.sessionId);
    await service.leave(second.sessionId);
    await new Promise((r) => setTimeout(r, 50)); // idle timeout (0s) tears the session down

    // A second, un-deduped session would spawn its own ffmpeg and never get killed:
    // nothing left in `sessions` points back to it once the surviving one wins.
    expect(procs.length).toBe(1);
    expect(procs.every((p) => p.kill.mock.calls.length > 0)).toBe(true);
  });

  it('lets a later caller retry after every concurrent opener saw the same failure', async () => {
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      setImmediate(() => {
        proc.exitCode = 1;
        proc.emit('exit', 1);
      });
      return proc as unknown as ReturnType<typeof spawn>;
    });
    const channel = makeChannel([makeStream({ id: 103, channelId: 103 })], { id: 103 });

    await expect(
      Promise.all([service.open(channel, makeUser(1), {}), service.open(channel, makeUser(2), {})]),
    ).rejects.toMatchObject({ response: { code: 'livetv_channel_unavailable' } });
    // One shared attempt tried the only stream twice (MAX_FAILURES_PER_STREAM), not four times.
    expect(spawn).toHaveBeenCalledTimes(2);

    mockSpawnAlwaysSucceeds();
    const result = await service.open(channel, makeUser(3), {});
    expect(result.channelId).toBe(103);
    // Lets this test's own fire-and-forget teardown fs.rm settle before the next test reuses the dir.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('purges viewerIndex entries when a running session exhausts every stream', async () => {
    let calls = 0;
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      calls++;
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      if (calls === 1) {
        setImmediate(() => fs.writeFileSync(path.join(dir, 'seg-00000.m4s'), 'x'));
      } else {
        setImmediate(() => {
          proc.exitCode = 1;
          proc.emit('exit', 1);
        });
      }
      return proc as unknown as ReturnType<typeof spawn>;
    });
    const channel = makeChannel([makeStream({ id: 104, channelId: 104 })], { id: 104 });

    const result = await service.open(channel, makeUser(1), {});
    const runningProc = spawn.mock.results[0].value as FakeProc;
    runningProc.exitCode = 1;
    runningProc.emit('exit', 1); // upstream dies while the viewer is still attached
    await new Promise((r) => setTimeout(r, 700)); // handleFailure -> recover's 300ms poll, twice over

    expect(service.getForServe(result.sessionId)).toBeUndefined();
    expect(
      (service as never as { viewerIndex: Map<string, string> }).viewerIndex.has(result.sessionId),
    ).toBe(false);
  });

  it('rejects a new session when the source is already at capacity', async () => {
    mockSpawnAlwaysSucceeds();
    const source = makeSource({ id: 10, maxStreams: 1 });
    const channel1 = makeChannel([makeStream({ id: 1, sourceId: 10, source })], { id: 1 });
    const channel2 = makeChannel([makeStream({ id: 2, sourceId: 10, source })], { id: 2 });

    await service.open(channel1, makeUser(1), {});
    await expect(service.open(channel2, makeUser(1), {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    try {
      await service.open(channel2, makeUser(1), {});
    } catch (err) {
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'livetv_source_at_capacity',
        sourceName: 'Test source',
        limit: 1,
      });
    }
  });

  it('advances to the next stream when the first one fails', async () => {
    let calls = 0;
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      calls++;
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      if (calls === 1) {
        // First stream: dies without ever producing a segment.
        setImmediate(() => {
          proc.exitCode = 1;
          proc.emit('exit', 1);
        });
      } else {
        setImmediate(() => fs.writeFileSync(path.join(dir, 'seg-00000.m4s'), 'x'));
      }
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const streamA = makeStream({ id: 1, priority: 0, url: 'http://a.example/1.ts' });
    const streamB = makeStream({ id: 2, priority: 1, url: 'http://b.example/1.ts' });
    const channel = makeChannel([streamA, streamB]);

    const result = await service.open(channel, makeUser(1), {});

    expect(calls).toBe(2);
    expect(spawn.mock.calls[1][1]).toContain('http://b.example/1.ts');
    expect(result.channelId).toBe(1);
  });

  it('gives up and reports the channel unavailable once every stream has failed twice', async () => {
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      setImmediate(() => {
        proc.exitCode = 1;
        proc.emit('exit', 1);
      });
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const channel = makeChannel([makeStream({ id: 1 })]);
    await expect(service.open(channel, makeUser(1), {})).rejects.toMatchObject({
      response: { code: 'livetv_channel_unavailable' },
    });
    expect(spawn).toHaveBeenCalledTimes(2); // one stream, tried twice
  });

  it('names the expired account instead of the generic message once every stream on it has failed', async () => {
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      setImmediate(() => {
        proc.exitCode = 1;
        proc.emit('exit', 1);
      });
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const source = makeSource({ id: 20, accountStatus: 'Expired' });
    const channel = makeChannel([makeStream({ id: 1, sourceId: 20, source })]);

    await expect(service.open(channel, makeUser(1), {})).rejects.toMatchObject({
      response: { code: 'livetv_account_expired', sourceName: 'Test source' },
    });
    expect(streamRepo.update).toHaveBeenCalledWith(1, { lastError: 'account expired' });
  });

  it('kills the process after the idle window once the last viewer leaves', async () => {
    settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'livetv_channel_idle_seconds' ? '0' : null),
    );
    const procs = mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(1), {});
    await service.leave(result.sessionId);
    await new Promise((r) => setTimeout(r, 50));

    expect(procs[0].kill).toHaveBeenCalled();
  });

  it('does not tear down when a viewer rejoins inside the idle window', async () => {
    settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'livetv_channel_idle_seconds' ? '5' : null),
    );
    const procs = mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(1), {});
    await service.leave(result.sessionId);
    // Instant zap-back: same channel, same mode, no new ffmpeg process.
    await service.open(channel, makeUser(1), {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(procs[0].kill).not.toHaveBeenCalled();
  });

  it('transcodes a channel the probe says is not h264, rather than copying it', async () => {
    mockSpawnAlwaysSucceeds();
    mockProbe('mpeg2video', 'mp2');
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(), {});

    // Copying MPEG-2 into fMP4 succeeds and plays nowhere, so the gate must bite.
    expect(result.mode).toBe('transcode');
    expect(streamRepo.update).toHaveBeenCalledWith(1, {
      probedVideoCodec: 'mpeg2video',
      probedAudioCodec: 'mp2',
      probedContainer: 'mpegts',
    });
  });

  it('probes a stream once and reuses the answer', async () => {
    mockSpawnAlwaysSucceeds();
    const stream = makeStream();
    const channel = makeChannel([stream]);

    await service.open(channel, makeUser(), {});
    await service.open(channel, makeUser(2), {});

    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('transcodes rather than guessing when the probe cannot reach the stream', async () => {
    mockSpawnAlwaysSucceeds();
    mockProbe(null);
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(), {});

    // An unknown codec is never assumed to be remuxable: that assumption is
    // what serves a browser an MPEG-2 track and a black screen.
    expect(result.mode).toBe('transcode');
  });

  it('prefers transcode over remux for a cold session when hardware encoding is available', async () => {
    mockSpawnAlwaysSucceeds();
    transcoding.getDetectedHwAccel.mockReturnValue('qsv');
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(), {});

    expect(result.mode).toBe('transcode');
  });

  it('keeps a different container from sharing the same session', async () => {
    mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream()]);

    await service.open(channel, makeUser(1), { useTs: false });
    await service.open(channel, makeUser(2), { useTs: true });

    // webOS (TS) and a browser (fMP4) must never share one ffmpeg output.
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('snaps a requested bitrate to a fixed rung, so nearby values share one session', async () => {
    mockSpawnAlwaysSucceeds();
    const channel = makeChannel([makeStream()]);

    await service.open(channel, makeUser(1), { maxBitrateBps: 2_000_000 });
    await service.open(channel, makeUser(2), { maxBitrateBps: 2_900_000 });

    // Both requests round up to the same 3 Mbps rung: one shared ffmpeg, not two,
    // and an unbounded requested value can never key its own distinct process.
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('-b:v') + 1]).toBe('3000000');
  });

  it('orders same-priority streams by health, a clean stream before an errored one', async () => {
    const picked: string[] = [];
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      picked.push(args[args.indexOf('-i') + 1]);
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      setImmediate(() => fs.writeFileSync(path.join(dir, 'seg-00000.m4s'), 'x'));
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const bad = makeStream({ id: 1, priority: 0, url: 'http://bad.example/1.ts', lastError: 'timeout' });
    const good = makeStream({
      id: 2,
      priority: 0,
      url: 'http://good.example/1.ts',
      lastError: null,
      lastOkAt: new Date(),
    });
    const channel = makeChannel([bad, good]);

    await service.open(channel, makeUser(1), {});

    expect(picked[0]).toBe('http://good.example/1.ts');
  });

  it('switches a remux session to transcode when a failover stream is not remuxable', async () => {
    let spawnCalls = 0;
    execFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
        const url = args[args.length - 1];
        if (url.includes('a.example')) cb(null, 'h264,video\naac,audio\nmpegts\n');
        else cb(null, 'mpeg2video,video\nmp2,audio\nmpegts\n');
      },
    );
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      spawnCalls++;
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      if (spawnCalls === 1) {
        // The h264 primary dies without ever producing a segment.
        setImmediate(() => {
          proc.exitCode = 1;
          proc.emit('exit', 1);
        });
      } else {
        setImmediate(() => fs.writeFileSync(path.join(dir, 'seg-00000.m4s'), 'x'));
      }
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const streamA = makeStream({ id: 1, priority: 0, url: 'http://a.example/1.ts' });
    const streamB = makeStream({ id: 2, priority: 1, url: 'http://b.example/1.ts' });
    const channel = makeChannel([streamA, streamB]);

    const result = await service.open(channel, makeUser(1), {});

    // A failover to an unremuxable backup must force transcode, not a black screen.
    expect(result.mode).toBe('transcode');
    const secondArgs: string[] = spawn.mock.calls[1][1];
    expect(secondArgs).toContain('-b:v');
    const flagsIdx = secondArgs.indexOf('-hls_flags');
    // The old init segment described h264: this run must start fresh, not append.
    expect(secondArgs[flagsIdx + 1]).not.toContain('append_list');
  });

  it('recounts against the new source after a cross-source failover', async () => {
    // Isolated from the release-grace behaviour (covered by its own test below).
    settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'livetv_slot_release_seconds' ? '0' : null),
    );
    let spawnCalls = 0;
    spawn.mockImplementation((_cmd: string, args: string[]) => {
      spawnCalls++;
      const dir = path.dirname(args[args.indexOf('-hls_segment_filename') + 1]);
      fs.mkdirSync(dir, { recursive: true });
      const proc = new FakeProc();
      if (spawnCalls === 1) {
        setImmediate(() => {
          proc.exitCode = 1;
          proc.emit('exit', 1);
        });
      } else {
        setImmediate(() => fs.writeFileSync(path.join(dir, 'seg-00000.m4s'), 'x'));
      }
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const sourceA = makeSource({ id: 1, maxStreams: 1 });
    const sourceB = makeSource({ id: 2, maxStreams: 1 });
    const streamA = makeStream({ id: 1, sourceId: 1, source: sourceA, priority: 0, url: 'http://a.example/1.ts' });
    const streamB = makeStream({ id: 2, sourceId: 2, source: sourceB, priority: 1, url: 'http://b.example/1.ts' });
    const channel = makeChannel([streamA, streamB], { id: 1 });

    await service.open(channel, makeUser(1), {});

    // The session now lives on source B: source A's single slot must be free again.
    const otherOnA = makeChannel([makeStream({ id: 3, sourceId: 1, source: sourceA })], { id: 2 });
    await expect(service.open(otherOnA, makeUser(2), {})).resolves.toBeDefined();
  });

  it('charges an in-flight probe against the capacity budget', async () => {
    mockSpawnAlwaysSucceeds();
    const source = makeSource({ id: 10, maxStreams: 1 });
    const channel1 = makeChannel([makeStream({ id: 1, sourceId: 10, source })], { id: 1 });
    const channel2 = makeChannel([makeStream({ id: 2, sourceId: 10, source })], { id: 2 });

    let finishProbe: (() => void) | undefined;
    execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
        finishProbe = () => cb(null, 'h264,video\naac,audio\n');
      },
    );

    const opening = service.open(channel1, makeUser(1), {});
    await new Promise((r) => setImmediate(r)); // let ensureProbed register the in-flight probe

    await expect(service.open(channel2, makeUser(2), {})).rejects.toBeInstanceOf(ConflictException);

    finishProbe?.();
    await opening;
  });

  it('keeps a just-closed upstream counted during the release grace window', async () => {
    mockSpawnAlwaysSucceeds();
    settings.get.mockImplementation((key: string) =>
      Promise.resolve(
        key === 'livetv_channel_idle_seconds' ? '0' : key === 'livetv_slot_release_seconds' ? '30' : null,
      ),
    );
    const source = makeSource({ id: 10, maxStreams: 1 });
    const channel = makeChannel([makeStream({ id: 1, sourceId: 10, source })], { id: 1 });

    const result = await service.open(channel, makeUser(1), {});
    await service.leave(result.sessionId);
    await new Promise((r) => setTimeout(r, 50)); // idle timeout (0s) tears the session down

    await expect(service.open(channel, makeUser(2), {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('packages a playlist channel instead of opening it, and never dials the upstream', async () => {
    mockSpawnAlwaysSucceeds();
    mockProbe('h264', 'aac', 'hls');
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(1), { directPlay: true });

    // The probe settles it: a playlist describes a stream instead of being one,
    // and a direct attempt would cost the channel a recorded failure.
    expect(result.mode).not.toBe('direct');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('tees one shared upstream to two direct viewers', async () => {
    const upstream = new PassThrough();
    mockedAxiosGet.mockResolvedValue({ data: upstream, headers: { 'content-type': 'video/mp2t' } });
    const channel = makeChannel([makeStream()]);

    const first = await service.open(channel, makeUser(1), { directPlay: true });
    const second = await service.open(channel, makeUser(2), { directPlay: true });
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);

    const sessionA = service.getForServe(first.sessionId)!;
    const sessionB = service.getForServe(second.sessionId)!;
    expect(sessionA).toBe(sessionB);

    const teeA = service.attachDirectViewer(sessionA, first.sessionId);
    const teeB = service.attachDirectViewer(sessionB, second.sessionId);
    const gotA: Buffer[] = [];
    const gotB: Buffer[] = [];
    teeA.on('data', (c: Buffer) => gotA.push(c));
    teeB.on('data', (c: Buffer) => gotB.push(c));

    upstream.emit('data', Buffer.from('hello'));
    await new Promise((r) => setImmediate(r));

    expect(Buffer.concat(gotA).toString()).toBe('hello');
    expect(Buffer.concat(gotB).toString()).toBe('hello');
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('drops a slow direct viewer without touching the shared upstream', async () => {
    const upstream = new PassThrough();
    mockedAxiosGet.mockResolvedValue({ data: upstream, headers: {} });
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(1), { directPlay: true });
    const session = service.getForServe(result.sessionId)!;
    const slowTee = service.attachDirectViewer(session, result.sessionId);
    const destroyed = jest.fn();
    slowTee.on('close', destroyed);
    // Simulate a full buffer: the very next write reports backpressure.
    jest.spyOn(slowTee, 'write').mockReturnValue(false);

    upstream.emit('data', Buffer.from('x'));
    await new Promise((r) => setImmediate(r));

    expect(destroyed).toHaveBeenCalled();
    expect(session.directTees?.has(slowTee)).toBe(false);
    expect(upstream.destroyed).toBe(false);
  });

  it('keeps a direct viewer whose tee is flowing, even past the TTL', async () => {
    const upstream = new PassThrough();
    mockedAxiosGet.mockResolvedValue({ data: upstream, headers: { 'content-type': 'video/mp2t' } });
    const channel = makeChannel([makeStream()]);

    const result = await service.open(channel, makeUser(1), { directPlay: true });
    const session = service.getForServe(result.sessionId)!;
    service.attachDirectViewer(session, result.sessionId);

    // Simulate the TTL having elapsed with no getForServe call in between: a
    // direct client makes one long GET and never polls a playlist again.
    session.viewers.get(result.sessionId)!.lastSeenAt = Date.now() - 10 * 60 * 1000;

    upstream.emit('data', Buffer.from('x'));
    await new Promise((r) => setImmediate(r));

    (service as never as { sweepAbandoned: () => void }).sweepAbandoned();

    expect(service.getForServe(result.sessionId)).toBeDefined();
  });

  it('records the real upstream-open failure in lastError, not the generic startup message', async () => {
    mockedAxiosGet.mockRejectedValue(new Error('connect ECONNREFUSED 203.0.113.1:443'));
    const channel = makeChannel([makeStream({ id: 1 })]);

    await expect(service.open(channel, makeUser(1), { directPlay: true })).rejects.toMatchObject({
      response: { code: 'livetv_channel_unavailable' },
    });

    expect(streamRepo.update).toHaveBeenCalledWith(1, {
      lastError: expect.stringContaining('ECONNREFUSED'),
    });
  });
});
