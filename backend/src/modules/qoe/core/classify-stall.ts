import type {
  QoeEvent,
  StallClassification,
  StallContext,
  StallSegment,
} from './types';

/** Client and server clocks may differ; a match that needs this slack is low confidence. */
export const SKEW_MARGIN_MS = 5000;
export const SERVER_WAIT_MS = 1000;
export const STARVED_S = 1;
export const HEADROOM = 1.2;
export const DROPPED_BURST_RATIO = 0.1;
/** Below this many decoded frames between two samples a ratio is noise. */
export const MIN_BURST_FRAMES = 30;

type StallInput = Pick<
  QoeEvent,
  'at' | 'durationMs' | 'bufferAheadS' | 'bandwidthBps' | 'variantBitrate'
>;

const speedOf = (s: StallSegment) =>
  (s.segmentDurationS * 1000) / Math.max(s.waitedMs ?? 1, 1);

/** The longest ffmpeg wait among the segments that overlap [lo, hi], if it explains a stall. */
function serverHit(segments: StallSegment[], lo: number, hi: number) {
  const hits = segments.filter(
    (s) => s.waitedMs != null && s.at >= lo && s.at - s.waitedMs <= hi,
  );
  if (!hits.length) return null;
  const worst = hits.reduce((a, b) => (b.waitedMs! > a.waitedMs! ? b : a));
  const speeds = hits.map(speedOf).sort((a, b) => a - b);
  const median = speeds[speeds.length >> 1];
  return worst.waitedMs! > SERVER_WAIT_MS || median < 1
    ? { waitedMs: worst.waitedMs!, transcodeSpeed: speedOf(worst) }
    : null;
}

function droppedBurst(start: number, ctx: StallContext): number | null {
  const before = [...ctx.samples].reverse().find((s) => s.at <= start);
  const after = ctx.samples[ctx.samples.length - 1];
  if (!before || !after || after.at <= before.at) return null;
  if (before.droppedFrames == null || before.decodedFrames == null) return null;
  if (after.droppedFrames == null || after.decodedFrames == null) return null;
  const decoded = after.decodedFrames - before.decodedFrames;
  const dropped = after.droppedFrames - before.droppedFrames;
  if (decoded < MIN_BURST_FRAMES || dropped < 0) return null;
  return dropped / decoded;
}

/** Why one stall happened; first matching rule wins, see plan/playback-qoe.plan.md. */
export function classifyStall(
  stall: StallInput,
  ctx: StallContext,
): StallClassification {
  const start = stall.at - (stall.durationMs ?? 0);
  const buffer = stall.bufferAheadS ?? ctx.bufferAheadS;
  const bandwidth = stall.bandwidthBps ?? ctx.bandwidthBps;
  const bitrate = stall.variantBitrate ?? ctx.variantBitrate;
  const evidence: Record<string, number> = {};
  if (buffer != null) evidence.bufferAheadS = buffer;
  if (bandwidth != null) evidence.bandwidthBps = bandwidth;
  if (bitrate != null) evidence.variantBitrate = bitrate;
  const out = (
    cause: StallClassification['cause'],
    confidence: StallClassification['confidence'],
    reason: string,
  ): StallClassification => ({
    cause,
    confidence,
    reason: `qoe.stall.${reason}`,
    evidence,
  });

  const strict = serverHit(ctx.segments, start, stall.at);
  const wide = strict
    ? null
    : serverHit(ctx.segments, start - SKEW_MARGIN_MS, stall.at + SKEW_MARGIN_MS);
  const server = strict ?? wide;
  if (server) {
    Object.assign(evidence, server);
    return out('server', strict ? 'high' : 'low', 'server_wait');
  }

  const starved = buffer != null && buffer < STARVED_S;
  const lowThroughput =
    bandwidth != null && bitrate != null && bandwidth < HEADROOM * bitrate;
  if (starved && lowThroughput) return out('network', 'high', 'network_starved');

  const burst = droppedBurst(start, ctx);
  if (burst != null && burst >= DROPPED_BURST_RATIO) {
    evidence.droppedPct = burst * 100;
    return out('device', starved ? 'low' : 'high', 'device_dropped_frames');
  }
  if (buffer != null && !starved) return out('device', 'high', 'device_buffer_ahead');
  // Starved with throughput that looks fine or is unknown: data still did not arrive in time.
  if (starved) return out('network', 'low', 'network_unconfirmed');
  if (lowThroughput) return out('network', 'low', 'network_low_throughput');
  return out('unknown', 'low', 'unknown');
}
