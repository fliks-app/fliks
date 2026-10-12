import { QoeService } from './qoe.service';
import { SessionRouter } from '../streaming/services/session-router.service';
import type { QoeSample } from './core/types';

const session = {
  sessionId: 's1',
  userId: 7,
  mediaFileId: 3,
  mediaTitle: 'Film',
  startedAt: 1_000,
  lastBeat: 2_000,
  deviceLabel: 'TV',
  systemName: null,
  appVersion: null,
  kind: 'transcode' as const,
  quality: '1080p',
  transcodeReasons: [],
  attributedUserId: null,
  state: 'playing' as const,
};

const sample: QoeSample = {
  engine: 'shaka',
  cmcd: false,
  droppedFrames: 0,
  decodedFrames: 100,
  bandwidthBps: null,
  bufferAheadS: null,
  variantBitrate: null,
  width: null,
  height: null,
  videoCodec: null,
  decoderName: null,
  hwDecoder: null,
  stallCount: 0,
  stallMs: 0,
  recoveryReloads: 0,
};

function build(repo: object = {}, eventsRepo: object = {}) {
  const upsert = jest.fn().mockResolvedValue(undefined);
  const insert = jest.fn().mockResolvedValue(undefined);
  const svc = new QoeService(
    { get: jest.fn(), addChangeListener: jest.fn() } as never,
    { upsert, create: (x: unknown) => x, ...repo } as never,
    { insert, ...eventsRepo } as never,
  );
  return { svc, upsert, insert };
}

const row = (o: Record<string, unknown>) => ({
  sessionId: 'a',
  playbackId: 'pb',
  userId: 7,
  mediaFileId: 3,
  mediaTitle: 'Film',
  startedAt: new Date(0),
  lastSeenAt: new Date(60_000),
  endedAt: null,
  deviceLabel: 'TV',
  engine: 'shaka',
  cmcd: false,
  cmcdClaimed: false,
  hwDecoder: null,
  watchedMs: 30_000,
  stallCount: 0,
  stallMs: 0,
  droppedFrames: null,
  decodedFrames: null,
  recoveryReloads: 0,
  errorCount: 0,
  avgBandwidthBps: null,
  minBandwidthBps: null,
  avgVariantBitrate: null,
  medianTranscodeSpeed: null,
  stallBufferAheadS: null,
  stallBandwidthBps: null,
  cmcdThroughputBps: null,
  unrecoveredError: false,
  sampleCount: 3,
  verdict: 'unknown',
  ...o,
});

describe('QoeService', () => {
  it('stores nothing while disabled', () => {
    const { svc } = build();
    (svc as unknown as { enabledFlag: boolean }).enabledFlag = false;
    svc.recordSample(session, sample);
    expect(svc.liveSummary('s1')).toBeNull();
  });

  it('caps events per session at 200 and flushes them with the row', async () => {
    const { svc, upsert, insert } = build();
    svc.recordSample(session, sample);
    const events = Array.from({ length: 150 }, () => ({
      type: 'stall' as const,
      at: 1,
      position: 1,
    }));
    svc.recordEvents(session, events);
    svc.recordEvents(session, events);
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      endedAt: expect.any(Date),
      stallCount: 0,
    });
    expect(insert.mock.calls[0][0]).toHaveLength(200);
  });

  it('keeps an ended session for late events and stores them on the ended row', async () => {
    const { svc, upsert, insert } = build();
    svc.recordSample(session, sample);
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    expect(svc.trackedSession('s1')).toBe(session);
    svc.recordEvents(session, [{ type: 'error', at: 1, position: 1 }]);
    await (svc as unknown as { sweep(): Promise<void> }).sweep();
    expect(insert.mock.calls[0][0]).toHaveLength(1);
    expect(upsert.mock.calls.at(-1)?.[0].endedAt).toEqual(expect.any(Date));
    expect(svc.trackedSession('nope')).toBeNull();
  });

  it('writes no row for a session that never reported a sample or event', async () => {
    const { svc, upsert } = build();
    svc.observeSegment(session, { query: { CMCD: 'bl=100' }, headers: {} } as never, 3, 50);
    svc.sessionEnded(session);
    await (svc as unknown as { sweep(): Promise<void> }).sweep();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reads CMCD off a segment request', () => {
    const { svc } = build();
    svc.observeSegment(
      session,
      { query: { CMCD: 'mtp=20000,bl=3000' }, headers: {} } as never,
      3,
      null,
    );
    expect(svc.liveSummary('s1')).toMatchObject({
      cmcd: true,
      bandwidthBps: 20_000_000,
    });
  });

  it('requeues events when a flush fails and retries them', async () => {
    const { svc, upsert, insert } = build();
    upsert.mockRejectedValueOnce(new Error('db down'));
    svc.recordEvents(session, [{ type: 'stall', at: 1, position: 1 }]);
    await (svc as unknown as { sweep(): Promise<void> }).sweep();
    expect(insert).not.toHaveBeenCalled();
    await (svc as unknown as { sweep(): Promise<void> }).sweep();
    expect(insert.mock.calls[0][0]).toHaveLength(1);
  });

  it('never drops a final flush requested while one is in flight', async () => {
    const { svc, upsert } = build();
    let release!: () => void;
    upsert.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    svc.recordSample(session, sample);
    const sweeping = (svc as unknown as { sweep(): Promise<void> }).sweep();
    svc.sessionEnded(session);
    release();
    await sweeping;
    await new Promise((r) => setImmediate(r));
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][0].endedAt).toEqual(expect.any(Date));
  });
});

describe('QoeService playbacks', () => {
  const a = row({ sessionId: 'a', watchedMs: 30_000, unrecoveredError: true, errorCount: 1 });
  const b = row({
    sessionId: 'b',
    startedAt: new Date(31_000),
    lastSeenAt: new Date(200_000),
    watchedMs: 90_000,
    cmcd: true,
    deviceLabel: 'TV 2',
  });

  it('merges the sessions of one playback and re-diagnoses the whole', async () => {
    const { svc } = build(
      {
        findOne: jest.fn().mockResolvedValue(b),
        find: jest.fn().mockResolvedValue([b, a]),
      },
      { find: jest.fn().mockResolvedValue([{ id: 1, sessionId: 'a', at: new Date(1), type: 'error', data: {} }]) },
    );
    const p = await svc.getSession('b');
    expect(p).toMatchObject({
      sessionId: 'b',
      sessionIds: ['a', 'b'],
      watchedMs: 120_000,
      deviceLabel: 'TV 2',
      cmcd: true,
      errorCount: 1,
      verdict: 'ok',
      lastSeenAt: new Date(200_000),
      startedAt: new Date(0),
    });
    expect(p?.sessions.map((r) => r.sessionId)).toEqual(['a', 'b']);
    expect(p?.events[0]).toMatchObject({ sessionId: 'a', type: 'error' });
  });

  it('resolves a playbackId and returns null for nothing', async () => {
    const find = jest.fn().mockResolvedValueOnce([a, b]).mockResolvedValueOnce([]);
    const { svc } = build(
      { findOne: jest.fn().mockResolvedValue(null), find },
      { find: jest.fn().mockResolvedValue([]) },
    );
    expect(await svc.getSession('pb')).toMatchObject({ sessionIds: ['a', 'b'] });
    expect(await svc.getSession('nope')).toBeNull();
  });

  it('counts playbacks, not sessions, in the summary', async () => {
    const getMany = jest.fn().mockResolvedValue([a, b, row({ sessionId: 'c', playbackId: null, watchedMs: 5_000 })]);
    const qb = { where: () => qb, take: () => qb, getMany };
    const { svc } = build({ createQueryBuilder: () => qb });
    const s = await svc.summary();
    expect(s.byVerdict).toMatchObject({ ok: 1, unknown: 1 });
    expect(s.byDevice.reduce((n, d) => n + d.sessions, 0)).toBe(2);
  });

  it('stores the playbackId from a sample or the events body', async () => {
    const { svc, upsert } = build();
    svc.recordSample(session, { ...sample, playbackId: 'pb1' });
    svc.recordEvents(session, [], 'pb2');
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    expect(upsert.mock.calls[0][0].playbackId).toBe('pb2');
    expect(svc.liveSummary('s1')?.playbackId).toBe('pb2');
  });
});

describe('CMCD query param on stream URLs', () => {
  it('does not disturb sid resolution or the freshness gate', () => {
    const touch = jest.fn().mockReturnValue(true);
    const router = new SessionRouter({ touch } as never, {} as never);
    router.assertFresh({
      query: { sid: 'abc', token: 't', CMCD: 'bl=100,sid="other",su' },
    } as never);
    expect(touch).toHaveBeenCalledWith('abc');
  });
});
