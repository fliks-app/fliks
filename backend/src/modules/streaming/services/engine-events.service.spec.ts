import { readFileSync } from 'fs';
import { join } from 'path';
import { LiveSessionRegistry } from '../live-session.service';
import type { EngineEvent } from '../../engine/engine.service';
import { EngineEventsService, sseData } from './engine-events.service';
import { jobKeyOf } from './engine-presence';

const { engine: recorded } = JSON.parse(
  readFileSync(join(__dirname, '../../../../../server/fixtures/playback-info/engine-playback.recorded.json'), 'utf8'),
) as { engine: any };

const snapshot = (over: Record<string, unknown> = {}): any => ({
  sessionId: 'sid-1',
  ownerId: '7',
  mediaFileId: 42,
  profileHash: 'abc',
  kind: 'transcode',
  quality: '480p',
  client: { userAgent: 'UA', systemName: 'macOS 26', appVersion: '1.2.3' },
  tags: {
    username: 'alice',
    mediaTitle: 'Dune',
    posterUrl: '/p.jpg',
    sseConnectionId: 'conn-1',
    attributedUserId: '9',
    deviceType: 'mobile',
  },
  openedAtMs: 1_000,
  lastBeatMs: 5_000,
  positionS: 33,
  state: 'paused',
  pinned: false,
  configRevision: 1,
  decision: recorded.decision,
  job: { state: 'running' },
  ...over,
});

function setup(runtime = true) {
  const qoe = {
    noteServedRung: jest.fn(),
    noteHwAccel: jest.fn(),
    observeServed: jest.fn(),
    sessionEnded: jest.fn(),
  };
  const liveSessions = new LiveSessionRegistry();
  const engine = {
    runtime,
    whenReady: jest.fn().mockResolvedValue(undefined),
    onConnect: jest.fn(),
    listSessions: jest.fn().mockResolvedValue([]),
    resyncJobs: jest.fn().mockResolvedValue(undefined),
    jobProgress: jest.fn(),
    jobEnded: jest.fn(),
    events: jest.fn(),
  };
  const svc = new EngineEventsService(
    engine as never,
    liveSessions,
  );
  return { svc, engine, qoe, liveSessions };
}

const body = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    },
  });

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('sseData', () => {
  it('yields the data of each event, across chunk boundaries and CRLF', async () => {
    const b = body(
      'event: A\r\ndata: {"a"',
      ':1}\r\n\r\n: ping\n\nevent: B\ndata: {"b":2}\n',
      '\ndata: x\n\n',
    );
    expect(await collect(sseData(b))).toEqual(['{"a":1}', '{"b":2}', 'x']);
  });

  it('reports every chunk, keep-alives included', async () => {
    const onBytes = jest.fn();
    await collect(sseData(body(': ping\n\n', ': ping\n\n'), onBytes));
    expect(onBytes).toHaveBeenCalledTimes(2);
  });
});

describe('EngineEventsService.handle', () => {
  it('hands background job events to the engine service', () => {
    const t = setup();
    t.svc.handle({ type: 'BgJobProgress', jobId: 'j1', pct: 40 });
    expect(t.engine.jobProgress).toHaveBeenCalledWith('j1', 40);
    const done = { type: 'BgJobDone', jobId: 'j1', state: 'done' } as const;
    t.svc.handle(done);
    expect(t.engine.jobEnded).toHaveBeenCalledWith('j1', done);
  });

  it('ends the presence on SessionEnded, which closes its QoE tracker', () => {
    const t = setup();
    t.liveSessions.create({
      sessionId: 'sid-1',
      userId: 7,
      username: null,
      mediaFileId: 42,
      kind: 'transcode',
    });
    t.svc.handle({
      type: 'SessionEnded',
      sessionId: 'sid-1',
      reason: 'expired',
    });
    expect(t.liveSessions.peek('sid-1')).toBeNull();
  });

  it('keeps the load counter from job events', () => {
    const t = setup();
    const started = (jobKey: string): EngineEvent => ({
      type: 'JobStarted',
      jobKey,
      mediaFileId: 1,
      quality: '480p',
      startSegment: 0,
      hwAccel: 'none',
    });
    t.svc.handle(started('a'));
    t.svc.handle(started('b'));
    t.svc.handle(started('a'));
    expect(t.svc.activeJobs).toBe(2);
    t.svc.handle({ type: 'JobEnded', jobKey: 'a', state: 'done', exitCode: 0 });
    expect(t.svc.activeJobs).toBe(1);
  });

  it('adopts a session opened elsewhere, but leaves an already-known one alone', () => {
    const t = setup();
    t.svc.handle({ type: 'SessionOpened', session: snapshot() });
    expect(t.liveSessions.peek('sid-1')).toMatchObject({
      userId: 7,
      username: 'alice',
    });
    const mine = t.liveSessions.peek('sid-1')!;
    mine.mediaTitle = 'changed';
    t.svc.handle({ type: 'SessionOpened', session: snapshot() });
    expect(t.liveSessions.peek('sid-1')).toBe(mine);
  });
});

describe('EngineEventsService.resync', () => {
  it('rebuilds presence from the snapshots and their tags', async () => {
    const t = setup();
    t.engine.listSessions.mockResolvedValue([snapshot()]);
    await t.svc.resync();
    const live = t.liveSessions.peek('sid-1')!;
    expect(live).toMatchObject({
      userId: 7,
      username: 'alice',
      mediaTitle: 'Dune',
      posterUrl: '/p.jpg',
      mediaFileId: 42,
      kind: 'transcode',
      quality: '480p',
      profileHash: 'abc',
      sseConnectionId: 'conn-1',
      attributedUserId: 9,
      deviceLabel: 'UA',
      systemName: 'macOS 26',
      appVersion: '1.2.3',
      position: 33,
      startedAt: 1_000,
      lastBeat: 5_000,
      state: 'paused',
    });
  });

  it('drops presence the engine no longer holds, but not one opened since the list was taken', async () => {
    const t = setup();
    const stale = t.liveSessions.create({
      sessionId: 'old',
      userId: 7,
      username: null,
      mediaFileId: 42,
      kind: 'transcode',
    });
    stale.startedAt = Date.now() - 60_000;
    t.engine.listSessions.mockImplementation(async () => {
      t.liveSessions.create({
        sessionId: 'new',
        userId: 7,
        username: null,
        mediaFileId: 42,
        kind: 'transcode',
      });
      return [snapshot()];
    });
    await t.svc.resync();
    expect(t.liveSessions.peek('old')).toBeNull();
    expect(t.liveSessions.peek('new')).not.toBeNull();
    expect(t.liveSessions.peek('sid-1')).not.toBeNull();
  });

  it('rebuilds the running-job counter, named as the engine names its jobs', async () => {
    const t = setup();
    const a = snapshot();
    t.engine.listSessions.mockResolvedValue([
      a,
      snapshot({ sessionId: 's2', ownerId: undefined, job: { state: 'done' } }),
    ]);
    await t.svc.resync();
    expect(t.svc.activeJobs).toBe(1);
    expect(jobKeyOf(a)).toBe('42-u7-abc');
    expect(jobKeyOf(snapshot({ ownerId: undefined }))).toBe('42-anon-abc');
    t.svc.handle({ type: 'JobEnded', jobKey: '42-u7-abc', state: 'done' });
    expect(t.svc.activeJobs).toBe(0);
  });
});

describe('EngineEventsService follower', () => {
  const sleeps: number[] = [];
  const frame = (e: EngineEvent) =>
    `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const sse = (...e: EngineEvent[]) =>
    new Response(body(...e.map(frame)), { status: 200 });

  function follow(runtime = true) {
    const t = setup(runtime);
    (t.svc as any).sleep = jest.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    return t;
  }
  beforeEach(() => (sleeps.length = 0));

  it('lists after subscribing, then applies the events', async () => {
    const t = follow();
    const order: string[] = [];
    t.engine.events.mockImplementation(async () => {
      order.push('subscribe');
      return sse({
        type: 'SessionEnded',
        sessionId: 'sid-1',
        reason: 'stopped',
      });
    });
    t.engine.listSessions.mockImplementation(async () => {
      order.push('list');
      return [snapshot()];
    });
    const ac = new AbortController();
    (t.svc as any).sleep = jest.fn(async () => ac.abort());
    await (t.svc as any).run(ac.signal);
    expect(order).toEqual(['subscribe', 'list']);
    expect(t.liveSessions.peek('sid-1')).toBeNull();
  });

  it('backs off while the engine is down, and starts over after a good connection', async () => {
    const t = follow();
    const ac = new AbortController();
    let calls = 0;
    t.engine.events.mockImplementation(async () => {
      calls++;
      if (calls <= 2) throw new Error('down');
      return sse();
    });
    (t.svc as any).sleep = jest.fn(async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 4) ac.abort();
    });
    await (t.svc as any).run(ac.signal);
    expect(sleeps).toEqual([500, 1000, 500, 500]);
    expect(t.engine.listSessions).toHaveBeenCalledTimes(2); // once per good connection
  });

  it('does not stream from an engine that does not run playback, and stops the previous follower', () => {
    const t = follow(false);
    t.svc.restart();
    expect(t.engine.events).not.toHaveBeenCalled();
  });

  it('restarts on every (re)connect of the engine', async () => {
    const t = follow();
    t.engine.events.mockImplementation(() => new Promise(() => undefined));
    t.svc.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.engine.events).toHaveBeenCalledTimes(1);
    const reconnect = t.engine.onConnect.mock.calls[0][0] as () => void;
    reconnect();
    await Promise.resolve();
    expect(t.engine.events).toHaveBeenCalledTimes(2);
    t.svc.onModuleDestroy();
  });
});
