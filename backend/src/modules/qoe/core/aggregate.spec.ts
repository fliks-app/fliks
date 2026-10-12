import { QoeAggregator } from './aggregate';
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
});
