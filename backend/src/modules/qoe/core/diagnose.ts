import type {
  QoeDiagnosis,
  QoeSessionSummary,
  ThroughputSource,
} from './types';

export const MIN_WATCHED_MS = 60_000;
export const STALLS_PER_10_MIN = 1;
export const STALL_RATIO = 0.01;
export const SERVER_SPEED_FLOOR = 1.0;
export const STARVED_BUFFER_S = 1;
/** Throughput must exceed the variant bitrate by this factor to be called sufficient. */
export const BANDWIDTH_HEADROOM = 1.2;
export const DROPPED_RATIO = 0.05;
export const HW_DECODER_MIN_HEIGHT = 1080;
/** Below this many decoded frames a dropped ratio is noise. */
export const MIN_DECODED_FRAMES = 300;

const TEN_MIN_MS = 600_000;

function throughput(
  s: QoeSessionSummary,
): { bps: number; source: ThroughputSource } | null {
  const engine = s.stallBandwidthBps ?? s.avgBandwidthBps;
  if (engine != null) return { bps: engine, source: 'engine' };
  if (s.cmcdThroughputBps != null) {
    return { bps: s.cmcdThroughputBps, source: 'cmcd' };
  }
  if (s.serverThroughputBps != null) {
    return { bps: s.serverThroughputBps, source: 'server' };
  }
  return null;
}

const result = (
  verdict: QoeDiagnosis['verdict'],
  confidence: QoeDiagnosis['confidence'],
  ...reasons: string[]
): QoeDiagnosis => ({
  verdict,
  confidence,
  reasons: reasons.map((r) => `qoe.reason.${r}`),
});

/** First matching rule wins; see plan/playback-qoe.plan.md section 1.3. */
export function diagnose(s: QoeSessionSummary): QoeDiagnosis {
  if (s.unrecoveredError) return result('error', 'high', 'fatal_error');

  const stalling =
    s.stallCount > 0 &&
    (s.stallCount / (s.watchedMs / TEN_MIN_MS || Infinity) >=
      STALLS_PER_10_MIN ||
      s.stallMs / Math.max(s.watchedMs, 1) >= STALL_RATIO);

  if (stalling) {
    if (
      s.medianTranscodeSpeed != null &&
      s.medianTranscodeSpeed < SERVER_SPEED_FLOOR
    ) {
      return result('server', 'high', 'stalls_server_slow');
    }
    // A stall with no buffer report is a starved buffer by definition.
    const buffer = s.stallBufferAheadS ?? s.minBufferAheadS;
    const starved = buffer == null || buffer < STARVED_BUFFER_S;
    if (starved) {
      const tp = throughput(s);
      const bitrate = s.avgVariantBitrate;
      if (tp == null || bitrate == null) {
        return result('network', 'low', 'stalls_starved_no_throughput');
      }
      const confidence =
        tp.source !== 'server' && s.stallBufferAheadS != null ? 'high' : 'low';
      if (tp.bps < BANDWIDTH_HEADROOM * bitrate) {
        return result('network', confidence, 'stalls_starved_low_throughput');
      }
      return result('device', 'low', 'stalls_starved_bandwidth_ok');
    }
    return result('device', 'high', 'stalls_buffer_ahead');
  }

  const dropped =
    s.droppedFrames != null &&
    s.decodedFrames != null &&
    s.decodedFrames >= MIN_DECODED_FRAMES &&
    s.droppedFrames / s.decodedFrames >= DROPPED_RATIO;
  if (dropped) return result('device', 'high', 'dropped_frames');
  if (
    s.hwDecoder === false &&
    s.height != null &&
    s.height >= HW_DECODER_MIN_HEIGHT
  ) {
    return result('device', 'high', 'software_decoder_hd');
  }

  const confidence = s.sampleCount > 0 || s.cmcd ? 'high' : 'low';
  if (s.watchedMs < MIN_WATCHED_MS) {
    return result('unknown', confidence, 'too_little_data');
  }
  return result('ok', confidence, 'healthy');
}
