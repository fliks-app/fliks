import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
    ({ id: 'k', cachePath: dir, startSegment, process: { exitCode: null } }) as unknown as TranscodeSession;
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
});
