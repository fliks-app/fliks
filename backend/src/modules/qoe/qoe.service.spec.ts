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
    {
      upsert,
      create: (x: unknown) => x,
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      ...repo,
    } as never,
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
  playbackVerdict: 'unknown',
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

  it('stores a live TV session without a media file, found again by trackedSession', async () => {
    const { svc, upsert } = build();
    const live = { ...session, sessionId: 'tv', mediaFileId: null, mediaTitle: 'Channel', kind: 'live' as const };
    svc.register(live);
    expect(svc.trackedSession('tv')).toBe(live);
    svc.recordSample(live, sample);
    svc.sessionEnded(live);
    await new Promise((r) => setImmediate(r));
    expect(upsert.mock.calls[0][0]).toMatchObject({
      mediaFileId: null,
      mediaTitle: 'Channel',
      playMethod: 'live',
      engine: 'shaka',
      endedAt: expect.any(Date),
    });
  });

  it('evicts an idle tracker that never reported, but keeps a reported one that is clean', async () => {
    const { svc } = build();
    svc.register({ ...session, sessionId: 'quiet' });
    svc.recordSample({ ...session, sessionId: 'loud' }, sample);
    const trackers = (svc as unknown as { trackers: Map<string, { touchedAt: number }> }).trackers;
    for (const t of trackers.values()) t.touchedAt = Date.now() - 21 * 60_000;
    await (svc as unknown as { sweep(): Promise<void> }).sweep();
    expect(svc.trackedSession('quiet')).toBeNull();
    expect(svc.trackedSession('loud')).toBeNull();
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

  it('stores the cause of a recorded stall in the event data and exposes the last stall', async () => {
    const { svc, insert } = build();
    svc.recordSample(session, sample);
    const at = Date.now();
    svc.observeSegment(session, { query: {}, headers: {} } as never, 6, 3_000);
    svc.recordEvents(session, [
      { type: 'stall', at, position: 5, durationMs: 4_000, bufferAheadS: 0.3 },
      { type: 'error', at, position: 5 },
    ]);
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    const [stall, error] = insert.mock.calls[0][0];
    expect(stall.data).toMatchObject({
      durationMs: 4_000,
      cause: 'server',
      causeConfidence: 'high',
      causeReason: 'qoe.stall.server_wait',
      causeEvidence: { waitedMs: 3_000 },
    });
    expect(error.data.cause).toBeUndefined();
    expect(svc.liveSummary('s1')?.lastStall).toEqual({
      at,
      durationMs: 4_000,
      cause: 'server',
      reason: 'qoe.stall.server_wait',
    });
  });

  it('stores the pipeline, follows a rung change and snapshots the server load on a stall', async () => {
    const { svc, upsert, insert } = build();
    svc.setLoadProbe(() => ({ activeTranscodes: 2, activeSessions: 5 }));
    const pipeline = {
      source: null,
      output: { codec: 'h264', hdr: null, quality: '1080p', bitrate: 8e6, requested: '1080p' },
      decode: null,
      encode: { hw: false, kind: 'cpu' },
      tonemap: null,
      burnIn: null,
      crop: null,
      audioTranscode: null,
    };
    svc.setPipeline(session, pipeline);
    svc.recordSample(session, sample);
    svc.updatePipelineOutput(session, '720p', 3e6);
    svc.recordEvents(session, [{ type: 'stall', at: Date.now(), position: 1, durationMs: 2_000 }]);
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    expect(upsert.mock.calls[0][0].pipeline).toMatchObject({
      output: { quality: '720p', bitrate: 3e6 },
      encode: { hw: false, kind: 'cpu' },
    });
    expect(insert.mock.calls[0][0][0].data.serverLoad).toEqual({
      activeTranscodes: 2,
      activeSessions: 5,
      loadAvg1: expect.any(Number),
      cpuCount: expect.any(Number),
    });
  });

  it('patches the pipeline to the cpu when the run fell back from the gpu, and adds live transcodes to the load', async () => {
    const { svc, upsert, insert } = build();
    svc.setLoadProbe(() => ({ activeTranscodes: 1, activeSessions: 2 }));
    svc.addTranscodeProbe(() => 2);
    const gpu = { hw: true, kind: 'qsv', name: 'h264_qsv' };
    svc.setPipeline(session, {
      source: null, output: null, decode: gpu, encode: gpu, tonemap: 'opencl', burnIn: null, crop: null, audioTranscode: null,
    });
    svc.recordSample(session, sample);
    svc.noteHwAccel(session, 'qsv');
    svc.noteHwAccel(session, 'none');
    svc.recordEvents(session, [{ type: 'stall', at: Date.now(), position: 1, durationMs: 2_000 }]);
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    expect(upsert.mock.calls[0][0].pipeline).toMatchObject({
      decode: { hw: false, kind: 'cpu' },
      encode: { hw: false, kind: 'cpu' },
      tonemap: 'cpu',
    });
    expect(insert.mock.calls[0][0][0].data.serverLoad).toMatchObject({ activeTranscodes: 3, activeSessions: 2 });
  });

  it('keeps the requested mode on the row and the rung actually served in the pipeline output', async () => {
    const { svc, upsert } = build();
    const auto = { ...session, quality: 'auto' };
    svc.setPipeline(auto, {
      source: null, output: { codec: 'h264', hdr: null, quality: null, bitrate: null, requested: 'auto' },
      decode: null, encode: null, tonemap: null, burnIn: null, crop: null, audioTranscode: null,
    });
    svc.recordSample(auto, sample);
    svc.noteServedRung(auto, 'auto', 8e6);
    svc.noteServedRung(auto, '1080p', 8e6);
    svc.sessionEnded(auto);
    await new Promise((r) => setImmediate(r));
    const row = upsert.mock.calls[0][0];
    expect(row.quality).toBe('auto');
    expect(row.pipeline.output).toMatchObject({ quality: '1080p', bitrate: 8e6, requested: 'auto' });
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
    const find = jest.fn().mockResolvedValue([b, a]);
    const { svc } = build(
      { findOne: jest.fn().mockResolvedValue(b), find },
      { find: jest.fn().mockResolvedValue([{ id: 1, sessionId: 'a', at: new Date(1), type: 'error', data: {} }]) },
    );
    const p = await svc.getSession('b');
    expect(find).toHaveBeenCalledWith({ where: { userId: 7, playbackId: 'pb' } });
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

  it('returns null for an unknown session, and never resolves a bare playbackId', async () => {
    const find = jest.fn();
    const { svc } = build({ findOne: jest.fn().mockResolvedValue(null), find });
    expect(await svc.getSession('pb')).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it('keeps two users sending the same playbackId as two playbacks', async () => {
    const other = row({ sessionId: 'z', userId: 8, watchedMs: 90_000, lastSeenAt: new Date(300_000) });
    const getMany = jest.fn().mockResolvedValue([a, b, other]);
    const getRawMany = jest.fn().mockResolvedValue([
      { key: 'x', uid: 8, pid: 'pb', total: '2' },
      { key: 'y', uid: 7, pid: 'pb', total: '2' },
    ]);
    const qb: Record<string, unknown> = { getMany, getRawMany };
    for (const m of ['select', 'addSelect', 'groupBy', 'having', 'orderBy', 'limit', 'offset', 'andWhere', 'where', 'orWhere']) {
      qb[m] = () => qb;
    }
    const { svc } = build({ createQueryBuilder: () => qb });
    const r = await svc.listSessions({ limit: 2, offset: 0 });
    expect(r.total).toBe(2);
    expect(r.items.map((i) => [i.userId, i.sessionIds])).toEqual([
      [8, ['z']],
      [7, ['a', 'b']],
    ]);
  });

  it('counts playbacks, not sessions, in the summary', async () => {
    const rows = [
      { device: 'TV', engine: 'shaka', hw: true, verdict: 'ok', stalls: '0', dropped: '5', decoded: '100' },
      { device: 'TV', engine: 'shaka', hw: null, verdict: 'unknown', stalls: '2', dropped: null, decoded: null },
    ];
    const qb: Record<string, unknown> = { getRawMany: jest.fn().mockResolvedValue(rows) };
    for (const m of ['select', 'addSelect', 'groupBy', 'having', 'orderBy']) qb[m] = () => qb;
    const { svc } = build({ createQueryBuilder: () => qb });
    const s = await svc.summary();
    expect(s.byVerdict).toMatchObject({ ok: 1, unknown: 1 });
    expect(s.byDevice).toEqual([
      expect.objectContaining({ sessions: 2, stallSessions: 1, avgDroppedPct: 5, hwDecoderPct: 100 }),
    ]);
  });

  it('stores the playbackId and restates the playback verdict on the siblings', async () => {
    const { svc, upsert } = build({ find: jest.fn().mockResolvedValue([a, b]) });
    const update = jest.fn();
    (svc as unknown as { sessions: { update: jest.Mock } }).sessions.update = update;
    svc.recordSample(session, { ...sample, playbackId: 'pb1' });
    svc.recordEvents(session, [], 'pb2');
    svc.sessionEnded(session);
    await new Promise((r) => setImmediate(r));
    expect(upsert.mock.calls[0][0].playbackId).toBe('pb2');
    expect(svc.liveSummary('s1')?.playbackId).toBe('pb2');
    expect(update).toHaveBeenCalledWith(
      { userId: 7, playbackId: 'pb2' },
      { playbackVerdict: 'ok', playbackConfidence: 'high' },
    );
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
