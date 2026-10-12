import { EventEmitter } from 'events';
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

function build() {
  const upsert = jest.fn().mockResolvedValue(undefined);
  const insert = jest.fn().mockResolvedValue(undefined);
  const svc = new QoeService(
    { get: jest.fn(), addChangeListener: jest.fn() } as never,
    { upsert, create: (x: unknown) => x } as never,
    { insert } as never,
  );
  return { svc, upsert, insert };
}

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
    svc.sessionEnded(session, true);
    await new Promise((r) => setImmediate(r));
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      endedAt: expect.any(Date),
      stallCount: 0,
    });
    expect(insert.mock.calls[0][0]).toHaveLength(200);
    expect(svc.liveSummary('s1')).toBeNull();
  });

  it('times the send and reads CMCD off a segment request', () => {
    const { svc } = build();
    const res = new EventEmitter() as unknown as import('express').Response;
    (res as unknown as { socket: { bytesWritten: number } }).socket = {
      bytesWritten: 0,
    };
    svc.observeSegment(
      session,
      { query: { CMCD: 'mtp=20000,bl=3000' }, headers: {} } as never,
      res,
      3,
      null,
    );
    (res as unknown as { socket: { bytesWritten: number } }).socket.bytesWritten = 1_000_000;
    res.emit('finish');
    expect(svc.liveSummary('s1')).toMatchObject({
      cmcd: true,
      bandwidthBps: 20_000_000,
    });
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
