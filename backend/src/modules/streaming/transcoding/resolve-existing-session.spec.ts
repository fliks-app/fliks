import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { REMUX_MAX_WAIT_SEGMENTS } from './constants';
import { TranscodingService } from './transcoding.service';
import type { TranscodeSession } from './types';

describe('TranscodingService.resolveExistingSession', () => {
  let dir: string;
  let svc: TranscodingService;
  let killed: number;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fliks-resolve-existing-'));
    svc = new TranscodingService({} as never, {} as never, {} as never, {} as never);
    killed = 0;
    (svc as unknown as { killProcess: () => Promise<void> }).killProcess = async () => {
      killed++;
    };
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const run = (startSegment: number) =>
    ({
      id: 'k',
      cachePath: dir,
      startSegment,
      process: { exitCode: null, signalCode: null },
    }) as unknown as TranscodeSession;
  const resolve = (session: TranscodeSession, seg: number) =>
    (svc as unknown as {
      resolveExistingSession: (k: string, s: TranscodeSession, n: number, q: boolean) => Promise<TranscodeSession | null>;
    }).resolveExistingSession('k', session, seg, true);

  it('waits on a run that has yet to write its first segment', async () => {
    const session = run(0);
    expect(await resolve(session, 0)).toBe(session);
    expect(await resolve(session, 2)).toBe(session);
    expect(killed).toBe(0);
  });

  it('still restarts a starting run for a segment before its start', async () => {
    expect(await resolve(run(10), 3)).toBeNull();
    expect(killed).toBe(1);
  });

  it('still restarts a starting run for a segment far past its start', async () => {
    expect(await resolve(run(0), 40)).toBeNull();
    expect(killed).toBe(1);
  });

  it('leaves the map entry in place on a restart, never absent for a concurrent lookup', async () => {
    const session = run(0);
    const sessions = (svc as unknown as { sessions: Map<string, TranscodeSession> }).sessions;
    sessions.set('k', session);
    expect(await resolve(session, 40)).toBeNull();
    // The caller overwrites this same key once it spawns the replacement; a
    // lookup racing in between (outside this call's lock) must see the
    // outgoing session, never nothing, or it may spawn its own duplicate.
    expect(sessions.get('k')).toBe(session);
  });

  it('respawns a SIGKILLed session instead of treating it as still running (exitCode null, signalCode set)', async () => {
    const session = {
      id: 'k',
      cachePath: dir,
      startSegment: 0,
      process: { exitCode: null, signalCode: 'SIGKILL' },
    } as unknown as TranscodeSession;
    expect(await resolve(session, 5)).toBeNull();
    // Already dead: the caller respawns directly, no kill needed.
    expect(killed).toBe(0);
  });

  it('drops a cleanly-exited session for another quality without touching its cache dir', async () => {
    await fsp.writeFile(path.join(dir, 'seg-0000.m4s'), 'x');
    const session = {
      id: 'k',
      cachePath: dir,
      startSegment: 0,
      process: { exitCode: 0, signalCode: null },
    } as unknown as TranscodeSession;
    const resolved = await (svc as unknown as {
      resolveExistingSession: (
        k: string,
        s: TranscodeSession,
        n: number,
        q: boolean,
      ) => Promise<TranscodeSession | null>;
    }).resolveExistingSession('k', session, 0, false);
    expect(resolved).toBeNull();
    expect(killed).toBe(0);
    // A clean exit (code 0) isn't a crash: its cache is still a valid rung.
    expect(await fsp.readdir(dir)).toContain('seg-0000.m4s');
  });

  describe('remux: reachability decided from the assembler frontier, not the directory', () => {
    // Mirrors RemuxSegmentAssembler.canServe: no measured throughput here, so
    // a live run's wait window is always the cap.
    const fakeAssembler = (
      startSegment: number,
      videoFrontier: number | null,
      audioFrontier: number | null = null,
    ) =>
      ({
        videoFrontier: () => videoFrontier,
        audioFrontier: () => audioFrontier,
        segmentsPerSecond: () => null,
        canServe: (segment: number, audioIndex: number | undefined, exited: boolean) => {
          const frontier = audioIndex != null ? audioFrontier : videoFrontier;
          if (exited) return frontier != null && segment >= startSegment && segment < frontier;
          if (segment < startSegment) return false;
          return frontier == null
            ? segment - startSegment <= REMUX_MAX_WAIT_SEGMENTS
            : segment <= frontier + REMUX_MAX_WAIT_SEGMENTS;
        },
      }) as unknown as TranscodeSession['remuxAssembler'];

    const runRemux = (startSegment: number, videoFrontier: number | null) =>
      ({
        id: 'k',
        cachePath: dir,
        startSegment,
        remux: true,
        remuxAssembler: fakeAssembler(startSegment, videoFrontier),
        process: { exitCode: null, signalCode: null },
      }) as unknown as TranscodeSession;

    it('waits when the request is below the frontier (already produced)', async () => {
      expect(await resolve(runRemux(0, 5), 3)).not.toBeNull();
      expect(killed).toBe(0);
    });

    it('waits just past the frontier, within the derived wait window', async () => {
      expect(await resolve(runRemux(0, 5), 6)).not.toBeNull();
      expect(killed).toBe(0);
    });

    it('restarts for a request below the run\'s own start, whatever an island on disk says', async () => {
      // A leftover island from a killed run could sit at seg-3 on disk; this
      // run's own start is 10, so 3 is never reachable by waiting on it.
      await fsp.writeFile(path.join(dir, 'seg-0003.m4s'), 'x');
      expect(await resolve(runRemux(10, 12), 3)).toBeNull();
      expect(killed).toBe(1);
    });

    it('restarts far past the frontier (T below start → never; T far ahead → seek)', async () => {
      expect(await resolve(runRemux(0, 5), 65)).toBeNull();
      expect(killed).toBe(1);
    });

    const exitedRemux = (startSegment: number, videoFrontier: number | null) =>
      ({
        id: 'k',
        cachePath: dir,
        startSegment,
        remux: true,
        remuxAssembler: fakeAssembler(startSegment, videoFrontier),
        process: { exitCode: 0 },
        outputDone: Promise.resolve(),
      }) as unknown as TranscodeSession;

    it('exited run: a segment past its own frontier respawns, even with a stale island on disk at that number', async () => {
      // An unrelated run's leftover seg-6 sits past this run's frontier (5).
      await fsp.writeFile(path.join(dir, 'seg-0006.m4s'), 'x');
      expect(await resolve(exitedRemux(0, 5), 6)).toBeNull();
    });

    it('exited run: a segment inside its produced range serves straight from it', async () => {
      expect(await resolve(exitedRemux(0, 5), 3)).not.toBeNull();
    });
  });
});
