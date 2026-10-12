import { diagnose } from './diagnose';
import type { QoeSessionSummary } from './types';

const base: QoeSessionSummary = {
  engine: 'shaka',
  cmcd: false,
  cmcdClaimed: false,
  videoCodec: 'hevc',
  width: 1920,
  height: 1080,
  decoderName: null,
  hwDecoder: true,
  watchedMs: 20 * 60_000,
  stallCount: 0,
  stallMs: 0,
  droppedFrames: 0,
  decodedFrames: 10_000,
  recoveryReloads: 0,
  errorCount: 0,
  unrecoveredError: false,
  bandwidthBps: null,
  variantBitrate: null,
  bufferAheadS: null,
  avgBandwidthBps: null,
  minBandwidthBps: null,
  avgVariantBitrate: null,
  stallBufferAheadS: null,
  stallBandwidthBps: null,
  cmcdThroughputBps: null,
  medianTranscodeSpeed: null,
  stallCauseMs: null,
  stallReasonMs: null,
  sampleCount: 10,
};

const d = (o: Partial<QoeSessionSummary>) => diagnose({ ...base, ...o });
const stalls = { stallCount: 3, stallMs: 9_000 };

describe('diagnose', () => {
  it('error: unrecovered error wins over everything', () => {
    expect(d({ unrecoveredError: true, ...stalls, medianTranscodeSpeed: 0.5 }))
      .toMatchObject({ verdict: 'error', confidence: 'high' });
  });

  it('server: stalls while ffmpeg is slower than real time', () => {
    expect(d({ ...stalls, medianTranscodeSpeed: 0.7, stallBufferAheadS: 0 }))
      .toMatchObject({ verdict: 'server', confidence: 'high' });
  });

  it('server: a live session tolerates jitter around 1x, a VOD one does not', () => {
    const o = { ...stalls, medianTranscodeSpeed: 0.95 };
    expect(diagnose({ ...base, ...o }, true).verdict).not.toBe('server');
    expect(diagnose({ ...base, ...o }).verdict).toBe('server');
    expect(diagnose({ ...base, ...stalls, medianTranscodeSpeed: 0.8 }, true).verdict).toBe('server');
  });

  it('network: starved buffer, engine throughput below 1.2x bitrate', () => {
    expect(
      d({
        ...stalls,
        stallBufferAheadS: 0.2,
        stallBandwidthBps: 5_000_000,
        avgVariantBitrate: 8_000_000,
      }),
    ).toMatchObject({ verdict: 'network', confidence: 'high' });
  });

  it('network: cmcd throughput without a stall buffer report is low confidence', () => {
    expect(
      d({
        ...stalls,
        cmcdThroughputBps: 5_000_000,
        avgVariantBitrate: 8_000_000,
      }),
    ).toMatchObject({ verdict: 'network', confidence: 'low' });
  });

  it('network low: starved but the stall carried no buffer report', () => {
    expect(
      d({ ...stalls, avgBandwidthBps: 2_000_000, avgVariantBitrate: 8_000_000 }),
    ).toMatchObject({ verdict: 'network', confidence: 'low' });
  });

  it('network low: starved with no throughput data', () => {
    expect(d({ ...stalls, stallBufferAheadS: 0 })).toMatchObject({
      verdict: 'network',
      confidence: 'low',
      reasons: ['qoe.reason.stalls_starved_no_throughput'],
    });
  });

  it('device: stalls with buffer ahead', () => {
    expect(d({ ...stalls, stallBufferAheadS: 12 })).toMatchObject({
      verdict: 'device',
      confidence: 'high',
    });
  });

  it('network low: starved although bandwidth is ample, like the per-stall rule', () => {
    expect(
      d({
        ...stalls,
        stallBufferAheadS: 0,
        avgBandwidthBps: 50_000_000,
        avgVariantBitrate: 8_000_000,
      }),
    ).toMatchObject({ verdict: 'network', confidence: 'low' });
  });

  it('a single stall in a long session is below both thresholds', () => {
    expect(
      d({ watchedMs: 120 * 60_000, stallCount: 1, stallMs: 2_000 }).verdict,
    ).toBe('ok');
  });

  it('stall ratio alone triggers', () => {
    expect(
      d({
        watchedMs: 120 * 60_000,
        stallCount: 1,
        stallMs: 120_000,
        stallBufferAheadS: 5,
      }).verdict,
    ).toBe('device');
  });

  it('device: dropped frames at 5 percent without stalls', () => {
    expect(d({ droppedFrames: 600 })).toMatchObject({
      verdict: 'device',
      confidence: 'high',
      reasons: ['qoe.reason.dropped_frames'],
    });
  });

  it('ignores a dropped ratio on a handful of frames', () => {
    expect(d({ droppedFrames: 5, decodedFrames: 50 }).verdict).toBe('ok');
  });

  it('a software decoder alone is not a verdict, only a hint on a device verdict', () => {
    expect(d({ hwDecoder: false }).verdict).toBe('ok');
    expect(d({ hwDecoder: false, droppedFrames: 600 }).reasons).toEqual([
      'qoe.reason.dropped_frames',
      'qoe.reason.software_decoder',
    ]);
  });

  it('does not hint a software decoder below 720p', () => {
    expect(d({ hwDecoder: false, droppedFrames: 600, height: 480 }).reasons).toEqual([
      'qoe.reason.dropped_frames',
    ]);
  });

  describe('stall causes', () => {
    const ms = (o: Partial<Record<'server' | 'network' | 'device' | 'unknown', number>>) => ({
      server: 0,
      network: 0,
      device: 0,
      unknown: 0,
      ...o,
    });

    it('follow the cause holding most of the stalled time, over the aggregates', () => {
      // aggregates alone would say server; the causes say network
      expect(
        d({ ...stalls, medianTranscodeSpeed: 0.5, stallCauseMs: ms({ network: 6_000, device: 3_000 }) }),
      ).toMatchObject({ verdict: 'network', confidence: 'high' });
    });

    it('take the session reason from the dominant per-stall reason', () => {
      const r = (reasonMs: Record<string, number>, causeMs: Record<string, number>) =>
        d({ ...stalls, stallCauseMs: ms(causeMs), stallReasonMs: reasonMs }).reasons;
      expect(r({ 'qoe.stall.network_unconfirmed': 5_000 }, { network: 5_000 })).toEqual(['qoe.reason.stalls_starved_bandwidth_ok']);
      expect(r({ 'qoe.stall.device_dropped_frames': 5_000 }, { device: 5_000 })).toEqual(['qoe.reason.dropped_frames']);
      expect(r({ 'qoe.stall.network_starved': 5_000 }, { network: 5_000 })).toEqual(['qoe.reason.stalls_starved_low_throughput']);
    });

    it('weigh by duration, not by count', () => {
      expect(
        d({ ...stalls, stallCauseMs: ms({ device: 1_000, server: 8_000 }) }).verdict,
      ).toBe('server');
    });

    it('are low confidence without a majority', () => {
      expect(
        d({ ...stalls, stallCauseMs: ms({ network: 4_000, device: 3_500, server: 1_500 }) }),
      ).toMatchObject({ verdict: 'network', confidence: 'low' });
    });

    it('fall back to the aggregates when unknown holds most of the time', () => {
      expect(
        d({ ...stalls, medianTranscodeSpeed: 0.5, stallCauseMs: ms({ unknown: 9_000 }) })
          .verdict,
      ).toBe('server');
    });

    it('never override a session that is not stalling', () => {
      expect(d({ stallCauseMs: ms({ network: 500 }) }).verdict).toBe('ok');
    });
  });

  it('unknown: under 60 s watched', () => {
    expect(d({ watchedMs: 30_000 }).verdict).toBe('unknown');
  });

  it('ok: confidence low without any client signal', () => {
    expect(d({})).toMatchObject({ verdict: 'ok', confidence: 'high' });
    expect(d({ sampleCount: 0 })).toMatchObject({
      verdict: 'ok',
      confidence: 'low',
    });
  });
});
