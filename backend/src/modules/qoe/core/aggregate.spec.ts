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

  it('turns CMCD buffer starvation into a starved stall when the client sends nothing', () => {
    const a = new QoeAggregator();
    a.addCmcd({ bl: 200, bs: true, mtp: 1000, br: 8000 });
    const s = a.summary();
    expect(s).toMatchObject({ stallCount: 1, stallBufferAheadS: 0.2 });
    expect(diagnose({ ...s, watchedMs: 5 * 60_000 })).toMatchObject({
      verdict: 'network',
      confidence: 'high',
    });
  });

  it('never overrides a client that reports samples, even with zero stalls', () => {
    const a = new QoeAggregator();
    a.addSample(sample({ stallCount: 0 }), 0);
    a.addCmcd({ bl: 100, bs: true });
    expect(a.summary()).toMatchObject({ stallCount: 0, stallBufferAheadS: null });
    const b = new QoeAggregator();
    b.addEvent({ type: 'stall', at: 1, position: 1, bufferAheadS: 5 }, 0);
    b.addCmcd({ bl: 100, bs: true });
    expect(b.summary()).toMatchObject({ stallCount: 0, stallBufferAheadS: 5 });
  });

  it('counts a run of bs requests as one stall and ignores startup', () => {
    const a = new QoeAggregator();
    a.addCmcd({ bs: true, su: true }, 0);
    a.addCmcd({ bs: true, bl: 100 }, 10_000);
    a.addCmcd({ bs: true, bl: 300 }, 12_000);
    a.addCmcd({ bs: true, bl: 200 }, 16_000);
    expect(a.summary().stallCount).toBe(1);
    a.addCmcd({ bs: true, bl: 400 }, 30_000);
    expect(a.summary()).toMatchObject({ stallCount: 2, stallBufferAheadS: 0.25 });
  });

  it('reads the stall buffer off video objects, not audio', () => {
    const a = new QoeAggregator();
    a.addCmcd({ bl: 9000, ot: 'a' }, 1_000);
    a.addCmcd({ bl: 300, ot: 'v' }, 1_500);
    a.addCmcd({ bl: 9000, ot: 'a' }, 1_800);
    a.addEvent({ type: 'stall', at: 1, position: 1 }, 2_000);
    expect(a.summary().stallBufferAheadS).toBe(0.3);
    const b = new QoeAggregator();
    b.addCmcd({ bl: 8000, bs: true, ot: 'a' }, 0);
    expect(b.summary().stallBufferAheadS).toBeNull();
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
});
