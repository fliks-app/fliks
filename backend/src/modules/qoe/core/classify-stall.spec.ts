import { classifyStall, SKEW_MARGIN_MS } from './classify-stall';
import type { StallContext } from './types';

const AT = 100_000;
const stall = { at: AT, durationMs: 4_000 };
const ctx = (o: Partial<StallContext> = {}): StallContext => ({
  segments: [],
  samples: [],
  bufferAheadS: null,
  bandwidthBps: null,
  variantBitrate: null,
  ...o,
});
const seg = (at: number, waitedMs: number | null, dur = 6) => ({
  at,
  segmentDurationS: dur,
  waitedMs,
});

describe('classifyStall', () => {
  it('server: a segment waited over 1 s for ffmpeg inside the window', () => {
    const r = classifyStall(stall, ctx({ segments: [seg(AT - 2_000, 3_200)] }));
    expect(r).toMatchObject({
      cause: 'server',
      confidence: 'high',
      reason: 'qoe.stall.server_wait',
    });
    expect(r.evidence.waitedMs).toBe(3_200);
    expect(r.evidence.transcodeSpeed).toBeCloseTo(6000 / 3200);
  });

  it('server wins over a starved buffer with low throughput', () => {
    const r = classifyStall(
      { ...stall, bufferAheadS: 0.2, bandwidthBps: 1e6, variantBitrate: 5e6 },
      ctx({ segments: [seg(AT - 1_000, 2_000)] }),
    );
    expect(r.cause).toBe('server');
  });

  it('server: speed below 1 on short segments even when the wait is under 1 s', () => {
    const r = classifyStall(
      stall,
      ctx({ segments: [seg(AT - 1_000, 900, 0.5)] }),
    );
    expect(r.cause).toBe('server');
  });

  it('server: a wait only reaching the window through the skew margin is low confidence', () => {
    const r = classifyStall(
      stall,
      ctx({ segments: [seg(AT + SKEW_MARGIN_MS - 500, 1_500)] }),
    );
    expect(r).toMatchObject({ cause: 'server', confidence: 'low' });
  });

  it('ignores a slow segment beyond the skew margin and a fast one inside the window', () => {
    const far = seg(AT + SKEW_MARGIN_MS + 2_000, 1_500);
    const fast = seg(AT - 1_000, 300);
    expect(
      classifyStall(stall, ctx({ segments: [far, fast], bufferAheadS: 3 })).cause,
    ).toBe('device');
  });

  it('live: judged by production speed against the 0.9 floor, not by the wait', () => {
    const live = (segments: ReturnType<typeof seg>[]) =>
      classifyStall(stall, ctx({ segments, live: true, bufferAheadS: 3 })).cause;
    expect(live([seg(AT - 1_000, 6_200)])).toBe('device');
    expect(live([seg(AT - 1_000, 7_500)])).toBe('server');
  });

  it('network: starved buffer and throughput below 1.2x the bitrate', () => {
    const r = classifyStall(
      { ...stall, bufferAheadS: 0.4, bandwidthBps: 1.9e6, variantBitrate: 5.5e6 },
      ctx(),
    );
    expect(r).toMatchObject({
      cause: 'network',
      confidence: 'high',
      reason: 'qoe.stall.network_starved',
      evidence: { bufferAheadS: 0.4, bandwidthBps: 1.9e6, variantBitrate: 5.5e6 },
    });
  });

  it('network: falls back to the fresh CMCD buffer, latest throughput and bitrate', () => {
    const r = classifyStall(
      stall,
      ctx({ bufferAheadS: 0.5, bandwidthBps: 4e6, variantBitrate: 5e6 }),
    );
    expect(r).toMatchObject({ cause: 'network', confidence: 'high' });
  });

  it('network (low): starved with fine throughput and no server wait', () => {
    const r = classifyStall(
      { ...stall, bufferAheadS: 0.2, bandwidthBps: 20e6, variantBitrate: 5e6 },
      ctx(),
    );
    expect(r).toMatchObject({
      cause: 'network',
      confidence: 'low',
      reason: 'qoe.stall.network_unconfirmed',
    });
  });

  it('network (low): starved with no throughput or bitrate data', () => {
    const r = classifyStall({ ...stall, bufferAheadS: 0 }, ctx());
    expect(r).toMatchObject({ cause: 'network', confidence: 'low' });
  });

  it('network (low): unknown buffer but throughput below the bitrate', () => {
    const r = classifyStall(stall, ctx({ bandwidthBps: 1e6, variantBitrate: 5e6 }));
    expect(r).toMatchObject({
      cause: 'network',
      confidence: 'low',
      reason: 'qoe.stall.network_low_throughput',
    });
  });

  it('device: the buffer was not starved', () => {
    const r = classifyStall({ ...stall, bufferAheadS: 2.1 }, ctx());
    expect(r).toMatchObject({
      cause: 'device',
      confidence: 'high',
      reason: 'qoe.stall.device_buffer_ahead',
    });
  });

  const samples = (dropped: number) => [
    { at: AT - 10_000, droppedFrames: 0, decodedFrames: 0 },
    { at: AT + 1_000, droppedFrames: dropped, decodedFrames: 600 },
  ];

  it('device: a burst of dropped frames between the samples around the stall', () => {
    const r = classifyStall(stall, ctx({ samples: samples(90) }));
    expect(r).toMatchObject({
      cause: 'device',
      confidence: 'high',
      reason: 'qoe.stall.device_dropped_frames',
    });
    expect(r.evidence.droppedPct).toBeCloseTo(15);
  });

  it('device (low): dropped burst but the buffer was starved with fine throughput', () => {
    const r = classifyStall(
      { ...stall, bufferAheadS: 0.1, bandwidthBps: 20e6, variantBitrate: 5e6 },
      ctx({ samples: samples(90) }),
    );
    expect(r).toMatchObject({ cause: 'device', confidence: 'low' });
  });

  it('a dropped ratio below 10 % is not a burst', () => {
    expect(classifyStall(stall, ctx({ samples: samples(30) })).cause).toBe(
      'unknown',
    );
  });

  it('unknown: nothing to decide from', () => {
    expect(classifyStall(stall, ctx())).toMatchObject({
      cause: 'unknown',
      confidence: 'low',
      reason: 'qoe.stall.unknown',
      evidence: {},
    });
  });
});
