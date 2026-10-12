import { diagnose } from './diagnose';
import { QoeAggregator, mergeSummaries } from './aggregate';
import type { QoeSample } from './types';

const sample = (o: Partial<QoeSample> = {}): QoeSample => ({
  engine: 'shaka',
  cmcd: false,
  droppedFrames: 0,
  decodedFrames: 0,
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
  ...o,
});

describe('QoeAggregator', () => {
  it('adds the new value as fresh when a counter decreases', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ droppedFrames: 10, decodedFrames: 1000, stallCount: 2 }), 0);
    a.addSample(sample({ droppedFrames: 25, decodedFrames: 2000, stallCount: 2 }), 10_000);
    a.addSample(sample({ droppedFrames: 3, decodedFrames: 100, stallCount: 0 }), 20_000);
    a.addSample(sample({ droppedFrames: 5, decodedFrames: 300, stallCount: 1 }), 30_000);
    expect(a.summary()).toMatchObject({
      droppedFrames: 30,
      decodedFrames: 2300,
      stallCount: 3,
    });
  });

  it('classifies the wait before a recovery, the server owning a lost session', () => {
    const a = new QoeAggregator();
    a.addSample(sample(), 0);
    const lost = a.addEvent({ type: 'recovery', at: 1, position: 873, reason: 'session_lost', durationMs: 9000 }, 1);
    expect(lost).toMatchObject({ cause: 'server', confidence: 'high', reason: 'qoe.stall.server_session_lost' });
    expect(a.addEvent({ type: 'recovery', at: 2, position: 900, reason: 'session_expired', durationMs: 4000 }, 2)).toMatchObject({
      cause: 'server',
      confidence: 'low',
    });
    // An instant recovery froze nothing.
    expect(a.addEvent({ type: 'recovery', at: 3, position: 950, reason: 'session_lost' }, 3)).toBeNull();
    expect(a.summary().stallCauseMs).toMatchObject({ server: 9000 + 2000 });
  });

  it('does not count a reload as a stall, an error or a recovery', () => {
    const a = new QoeAggregator();
    a.addSample(sample(), 0);
    const before = JSON.stringify(a.summary());
    expect(a.addEvent({ type: 'reload', at: 1, position: 5, reason: 'audio' }, 1)).toBeNull();
    expect(JSON.stringify(a.summary())).toBe(before);
  });

  it('keeps a counter null when the engine never reports it', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ droppedFrames: null, decodedFrames: null }), 0);
    expect(a.summary()).toMatchObject({ droppedFrames: null, decodedFrames: null });
  });

  it('counts watched time between samples, skipping pauses and long gaps', () => {
    const a = new QoeAggregator();
    a.addSample(sample(), 0);
    a.addSample(sample(), 10_000);
    a.addSample(sample(), 20_000, false);
    a.addSample(sample(), 200_000);
    expect(a.summary().watchedMs).toBe(10_000 + 30_000);
  });

  it('tracks bandwidth, bitrate and buffer', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ bandwidthBps: 4e6, variantBitrate: 8e6, bufferAheadS: 20 }), 0);
    a.addSample(sample({ bandwidthBps: 2e6, variantBitrate: 8e6, bufferAheadS: 0.5 }), 10_000);
    expect(a.summary()).toMatchObject({
      avgBandwidthBps: 3e6,
      minBandwidthBps: 2e6,
      avgVariantBitrate: 8e6,
      bufferAheadS: 0.5,
    });
  });

  it('flags an error with no recovery and no later sample', () => {
    const a = new QoeAggregator();
    a.addSample(sample(), 0);
    a.addEvent({ type: 'error', at: 1, position: 5 }, 5_000);
    expect(a.summary()).toMatchObject({ unrecoveredError: true, errorCount: 1 });
    a.addSample(sample(), 15_000);
    expect(a.summary().unrecoveredError).toBe(false);
  });

  it('a recovery after the error clears it', () => {
    const a = new QoeAggregator();
    a.addEvent({ type: 'error', at: 1, position: 5 }, 5_000);
    a.addEvent({ type: 'recovery', at: 2, position: 5 }, 6_000);
    expect(a.summary().unrecoveredError).toBe(false);
  });

  it('takes stall context medians from events', () => {
    const a = new QoeAggregator();
    for (const b of [0, 0.4, 9]) {
      a.addEvent({ type: 'stall', at: 1, position: 1, bufferAheadS: b, bandwidthBps: 1e6 }, 0);
    }
    expect(a.summary()).toMatchObject({ stallBufferAheadS: 0.4, stallBandwidthBps: 1e6 });
  });

  it('derives transcode speed only from waited segments and past the sample floor', () => {
    const a = new QoeAggregator();
    const seg = (waitedMs: number | null) => ({ segmentDurationS: 3, waitedMs });
    a.addSegment(seg(6000));
    a.addSegment(seg(null));
    a.addSegment(seg(6000));
    expect(a.summary().medianTranscodeSpeed).toBeNull();
    a.addSegment(seg(6000));
    expect(a.summary().medianTranscodeSpeed).toBeCloseTo(0.5);
  });

  it('folds cmcd in bps and seconds', () => {
    const a = new QoeAggregator();
    a.addCmcd({ mtp: 25_400, bl: 2100, br: 3000 });
    expect(a.summary()).toMatchObject({
      cmcd: true,
      cmcdThroughputBps: 25_400_000,
      variantBitrate: 3_000_000,
    });
  });

  it('fills a stall buffer from a fresh sample, not from a stale one', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ bufferAheadS: 0.3 }), 100_000);
    a.addEvent({ type: 'stall', at: 1, position: 1 }, 105_000);
    expect(a.summary().stallBufferAheadS).toBe(0.3);
    const b = new QoeAggregator();
    b.addSample(sample({ bufferAheadS: 0.3 }), 0);
    b.addEvent({ type: 'stall', at: 1, position: 1 }, 60_000);
    expect(b.summary().stallBufferAheadS).toBeNull();
  });

  it('keeps the client claim apart from what the server parsed', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ cmcd: true }), 0);
    expect(a.summary()).toMatchObject({ cmcd: false, cmcdClaimed: true });
    expect(diagnose(a.summary()).reasons).toContain('qoe.reason.cmcd_missing');
    a.addCmcd({ bl: 4000 });
    expect(a.summary()).toMatchObject({ cmcd: true, cmcdClaimed: true });
    expect(diagnose(a.summary()).reasons).not.toContain('qoe.reason.cmcd_missing');
  });

  it('reads the stall buffer off video objects, not audio', () => {
    const a = new QoeAggregator();
    a.addCmcd({ bl: 9000, ot: 'a' }, 1_000);
    a.addCmcd({ bl: 300, ot: 'v' }, 1_500);
    a.addCmcd({ bl: 9000, ot: 'a' }, 1_800);
    a.addEvent({ type: 'stall', at: 1, position: 1 }, 2_000);
    expect(a.summary().stallBufferAheadS).toBe(0.3);
  });

  it('takes a stall buffer from a fresh CMCD bl', () => {
    const a = new QoeAggregator();
    a.addCmcd({ bl: 400 }, 1_000);
    a.addEvent({ type: 'stall', at: 1, position: 1 }, 5_000);
    expect(a.summary().stallBufferAheadS).toBe(0.4);
  });
});

describe('mergeSummaries', () => {
  const part = (o: Partial<ReturnType<QoeAggregator['summary']>>) => ({
    ...new QoeAggregator().summary(),
    ...o,
  });

  it('sums counters, weights rates by watch time and keeps the latest identity', () => {
    const m = mergeSummaries([
      part({ watchedMs: 30_000, stallCount: 1, stallMs: 500, droppedFrames: 5, decodedFrames: 100, avgBandwidthBps: 2e6, minBandwidthBps: 1e6, engine: 'shaka', unrecoveredError: true, errorCount: 1, cmcdClaimed: true }),
      part({ watchedMs: 90_000, stallCount: 2, stallMs: 700, droppedFrames: null, decodedFrames: null, avgBandwidthBps: 6e6, minBandwidthBps: 3e6, engine: 'exoplayer', cmcd: true }),
    ]);
    expect(m).toMatchObject({
      watchedMs: 120_000,
      stallCount: 3,
      stallMs: 1200,
      droppedFrames: 5,
      decodedFrames: 100,
      avgBandwidthBps: 5e6,
      minBandwidthBps: 1e6,
      engine: 'exoplayer',
      cmcd: true,
      cmcdClaimed: true,
      errorCount: 1,
      unrecoveredError: false,
    });
  });

  it('adds frame counters only over parts that report both', () => {
    const m = mergeSummaries([
      part({ droppedFrames: 10, decodedFrames: null }),
      part({ droppedFrames: 5, decodedFrames: 100 }),
      part({ droppedFrames: null, decodedFrames: 50 }),
    ]);
    expect(m).toMatchObject({ droppedFrames: 5, decodedFrames: 100 });
  });

  it('classifies a stall from the segment waits and samples it holds', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ bandwidthBps: 2e6, variantBitrate: 5e6 }), 1_000);
    a.addSegment({ segmentDurationS: 6, waitedMs: 2_500 }, 9_000);
    expect(a.addEvent({ type: 'stall', at: 10_000, position: 1, durationMs: 3_000 }, 10_000)?.cause).toBe('server');
    const fine = a.addEvent({ type: 'stall', at: 60_000, position: 2, durationMs: 1_000, bufferAheadS: 0.2 }, 60_000);
    expect(fine).toMatchObject({ cause: 'network', confidence: 'high' });
    expect(a.lastStall).toMatchObject({ at: 60_000, cause: 'network' });
    expect(a.summary().stallCauseMs).toEqual({ server: 3_000, network: 1_000, device: 0, unknown: 0 });
    expect(a.addEvent({ type: 'error', at: 1, position: 1 }, 1)).toBeNull();
  });

  it('counts a low-confidence cause at half weight and tracks the reason', () => {
    const a = new QoeAggregator();
    a.addEvent({ type: 'stall', at: 1, position: 1, durationMs: 2_000, bufferAheadS: 0.2 }, 1);
    const s = a.summary();
    expect(s.stallCauseMs?.network).toBe(1_000);
    expect(s.stallReasonMs).toEqual({ 'qoe.stall.network_unconfirmed': 1_000 });
  });

  it('keeps stallCauseMs null without a classified stall and sums it on merge', () => {
    expect(new QoeAggregator().summary().stallCauseMs).toBeNull();
    const c = (ms: number) => ({ server: 0, network: ms, device: 0, unknown: 0 });
    const m = mergeSummaries([part({ stallCauseMs: c(10) }), part({ stallCauseMs: null }), part({ stallCauseMs: c(5) })]);
    expect(m.stallCauseMs).toEqual(c(15));
  });
});
