import { diagnose } from './diagnose';
import type { QoeSessionSummary } from './types';

const base: QoeSessionSummary = {
  engine: 'shaka',
  cmcd: false,
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
  minBufferAheadS: null,
  cmcdThroughputBps: null,
  serverThroughputBps: null,
  medianTranscodeSpeed: null,
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

  it('network: server-side throughput only is low confidence', () => {
    expect(
      d({
        ...stalls,
        stallBufferAheadS: 0,
        serverThroughputBps: 2_000_000,
        avgVariantBitrate: 8_000_000,
      }),
    ).toMatchObject({ verdict: 'network', confidence: 'low' });
  });

  it('network low: starved with no throughput data', () => {
    expect(d({ ...stalls, stallBufferAheadS: 0 })).toMatchObject({
      verdict: 'network',
      confidence: 'low',
    });
  });

  it('device: stalls with buffer ahead', () => {
    expect(d({ ...stalls, stallBufferAheadS: 12 })).toMatchObject({
      verdict: 'device',
      confidence: 'high',
    });
  });

  it('device low: starved although bandwidth is ample', () => {
    expect(
      d({
        ...stalls,
        stallBufferAheadS: 0,
        avgBandwidthBps: 50_000_000,
        avgVariantBitrate: 8_000_000,
      }),
    ).toMatchObject({ verdict: 'device', confidence: 'low' });
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

  it('device: software decoder on 1080p, not on 720p', () => {
    expect(d({ hwDecoder: false }).verdict).toBe('device');
    expect(d({ hwDecoder: false, height: 720 }).verdict).toBe('ok');
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
