import type {
  CmcdSnapshot,
  QoeEngine,
  QoeEvent,
  QoeSample,
  QoeSessionSummary,
  SegmentMetric,
} from './types';

/** Longest gap between two samples still counted as watched time (3 missed beats). */
const MAX_WATCH_GAP_MS = 30_000;
const MIN_SPEED_SAMPLES = 3;
/** A sample this fresh still describes the buffer at a stall reported without one. */
const MAX_SAMPLE_AGE_MS = 15_000;
/** Bounds memory on a multi-hour session. */
const MAX_KEPT = 200;
/** CMCD `bs` requests closer than this belong to the same starvation. */
const BS_RUN_GAP_MS = 5_000;

/** A cumulative counter that restarts from zero when the engine reloads. */
class ResettingCounter {
  private base = 0;
  private last: number | null = null;

  add(v: number | null): void {
    if (v == null) return;
    if (this.last != null && v < this.last) this.base += this.last;
    this.last = v;
  }

  get total(): number | null {
    return this.last == null ? null : this.base + this.last;
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const avg = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function push(xs: number[], v: number): void {
  xs.push(v);
  if (xs.length > MAX_KEPT) xs.shift();
}

/** Folds samples, events, segment metrics and CMCD reports into one session summary. */
export class QoeAggregator {
  private engine: QoeEngine | null = null;
  private cmcdSeen = false;
  private cmcdClaimed = false;
  private bsRuns = 0;
  private lastBsAt: number | null = null;
  private readonly bsBuffers: number[] = [];
  private cmcdBuffer: number | null = null;
  private cmcdBufferAt: number | null = null;
  private stallEvents = 0;
  private videoCodec: string | null = null;
  private width: number | null = null;
  private height: number | null = null;
  private decoderName: string | null = null;
  private hwDecoder: boolean | null = null;
  private watchedMs = 0;
  private lastSampleAt: number | null = null;
  private sampleCount = 0;
  private readonly dropped = new ResettingCounter();
  private readonly decoded = new ResettingCounter();
  private readonly stalls = new ResettingCounter();
  private readonly stallMs = new ResettingCounter();
  private readonly reloads = new ResettingCounter();
  private bandwidth: number | null = null;
  private variantBitrate: number | null = null;
  private bufferAhead: number | null = null;
  private readonly bandwidths: number[] = [];
  private readonly variantBitrates: number[] = [];
  private minBandwidth: number | null = null;
  private bufferAheadAt: number | null = null;
  private readonly stallBuffers: number[] = [];
  private readonly stallBandwidths: number[] = [];
  private readonly cmcdMtp: number[] = [];
  private readonly speeds: number[] = [];
  private errorCount = 0;
  private lastErrorAt: number | null = null;
  private lastRecoveryAt: number | null = null;

  /** `playing`: the session is not paused, so the gap since the last sample is watched time. */
  addSample(s: QoeSample, now: number, playing = true): void {
    if (this.lastSampleAt != null && playing) {
      this.watchedMs += Math.min(now - this.lastSampleAt, MAX_WATCH_GAP_MS);
    }
    this.lastSampleAt = now;
    this.sampleCount++;
    this.engine = s.engine;
    if (s.cmcd) this.cmcdClaimed = true;
    this.dropped.add(s.droppedFrames);
    this.decoded.add(s.decodedFrames);
    this.stalls.add(s.stallCount);
    this.stallMs.add(s.stallMs);
    this.reloads.add(s.recoveryReloads);
    if (s.videoCodec != null) this.videoCodec = s.videoCodec;
    if (s.width != null) this.width = s.width;
    if (s.height != null) this.height = s.height;
    if (s.decoderName != null) this.decoderName = s.decoderName;
    if (s.hwDecoder != null) this.hwDecoder = s.hwDecoder;
    if (s.bandwidthBps != null) {
      this.bandwidth = s.bandwidthBps;
      push(this.bandwidths, s.bandwidthBps);
      this.minBandwidth = Math.min(
        this.minBandwidth ?? Infinity,
        s.bandwidthBps,
      );
    }
    if (s.variantBitrate != null) {
      this.variantBitrate = s.variantBitrate;
      push(this.variantBitrates, s.variantBitrate);
    }
    if (s.bufferAheadS != null) {
      this.bufferAhead = s.bufferAheadS;
      this.bufferAheadAt = now;
    }
  }

  addEvent(e: QoeEvent, now: number): void {
    if (e.type === 'stall') {
      this.stallEvents++;
      const fresh = (at: number | null) =>
        at != null && now - at <= MAX_SAMPLE_AGE_MS;
      const buffer =
        e.bufferAheadS ??
        (fresh(this.bufferAheadAt) ? this.bufferAhead : null) ??
        (fresh(this.cmcdBufferAt) ? this.cmcdBuffer : null);
      if (buffer != null) push(this.stallBuffers, buffer);
      if (e.bandwidthBps != null) push(this.stallBandwidths, e.bandwidthBps);
    } else if (e.type === 'error') {
      this.errorCount++;
      this.lastErrorAt = now;
    } else if (e.type === 'recovery') {
      this.lastRecoveryAt = now;
    }
  }

  addSegment(m: SegmentMetric): void {
    if (m.waitedMs != null && m.segmentDurationS > 0) {
      push(this.speeds, (m.segmentDurationS * 1000) / Math.max(m.waitedMs, 1));
    }
  }

  addCmcd(c: CmcdSnapshot, now = Date.now()): void {
    this.cmcdSeen = true;
    // Audio buffers run deeper than video: only video or muxed objects say anything about a stall.
    const buffer = c.bl != null && c.ot !== 'a' ? c.bl / 1000 : null;
    if (buffer != null) {
      this.cmcdBuffer = buffer;
      this.cmcdBufferAt = now;
    }
    // Startup requests carry `bs` too; that is not a stall.
    if (c.bs && !c.su) {
      if (this.lastBsAt == null || now - this.lastBsAt > BS_RUN_GAP_MS) {
        this.bsRuns++;
        if (buffer != null) push(this.bsBuffers, buffer);
      }
      this.lastBsAt = now;
    }
    if (c.mtp != null) push(this.cmcdMtp, c.mtp * 1000);
    if (c.br != null && this.variantBitrates.length === 0) {
      this.variantBitrate = c.br * 1000;
    }
  }

  summary(): QoeSessionSummary {
    const lastErrorAt = this.lastErrorAt;
    // A client that reports at all (even zero stalls) is believed; `bs` only covers silent ones.
    const fromCmcd =
      this.sampleCount === 0 && this.stallEvents === 0 && this.bsRuns > 0;
    return {
      engine: this.engine,
      cmcd: this.cmcdSeen,
      cmcdClaimed: this.cmcdClaimed,
      videoCodec: this.videoCodec,
      width: this.width,
      height: this.height,
      decoderName: this.decoderName,
      hwDecoder: this.hwDecoder,
      watchedMs: this.watchedMs,
      stallCount: fromCmcd ? this.bsRuns : (this.stalls.total ?? 0),
      stallMs: this.stallMs.total ?? 0,
      droppedFrames: this.dropped.total,
      decodedFrames: this.decoded.total,
      recoveryReloads: this.reloads.total ?? 0,
      errorCount: this.errorCount,
      unrecoveredError:
        lastErrorAt != null &&
        (this.lastRecoveryAt ?? -1) < lastErrorAt &&
        (this.lastSampleAt ?? -1) <= lastErrorAt,
      bandwidthBps: this.bandwidth,
      variantBitrate: this.variantBitrate,
      bufferAheadS: this.bufferAhead,
      avgBandwidthBps: avg(this.bandwidths),
      minBandwidthBps: this.minBandwidth,
      avgVariantBitrate: avg(this.variantBitrates) ?? this.variantBitrate,
      stallBufferAheadS: median(fromCmcd ? this.bsBuffers : this.stallBuffers),
      stallBandwidthBps: median(this.stallBandwidths),
      cmcdThroughputBps: avg(this.cmcdMtp),
      medianTranscodeSpeed:
        this.speeds.length >= MIN_SPEED_SAMPLES ? median(this.speeds) : null,
      sampleCount: this.sampleCount,
    };
  }
}

function weighted(
  parts: QoeSessionSummary[],
  pick: (s: QoeSessionSummary) => number | null,
  weight: (s: QoeSessionSummary) => number,
): number | null {
  let sum = 0;
  let w = 0;
  for (const p of parts) {
    const v = pick(p);
    if (v == null) continue;
    const k = Math.max(weight(p), 1);
    sum += v * k;
    w += k;
  }
  return w ? sum / w : null;
}

/** Frame counters only add up over the parts that report both. */
function frames(
  parts: QoeSessionSummary[],
): Pick<QoeSessionSummary, 'droppedFrames' | 'decodedFrames'> {
  const both = parts.filter((p) => p.droppedFrames != null && p.decodedFrames != null);
  if (!both.length) return { droppedFrames: null, decodedFrames: null };
  return {
    droppedFrames: both.reduce((a, p) => a + (p.droppedFrames ?? 0), 0),
    decodedFrames: both.reduce((a, p) => a + (p.decodedFrames ?? 0), 0),
  };
}

/**
 * One viewing split over several sids: counters add up, rates are weighted by
 * watch time (stall count for stall-time medians), the rest follows the latest part.
 * `parts` is ordered oldest first.
 */
export function mergeSummaries(parts: QoeSessionSummary[]): QoeSessionSummary {
  const last = parts[parts.length - 1];
  if (parts.length === 1) return last;
  const latest = <K extends keyof QoeSessionSummary>(
    k: K,
  ): QoeSessionSummary[K] | null =>
    [...parts].reverse().find((p) => p[k] != null)?.[k] ?? null;
  const byWatch = (s: QoeSessionSummary) => s.watchedMs;
  const byStalls = (s: QoeSessionSummary) => s.stallCount;
  const mins = parts
    .map((p) => p.minBandwidthBps)
    .filter((x): x is number => x != null);
  const total = (f: (p: QoeSessionSummary) => number) =>
    parts.reduce((a, p) => a + f(p), 0);
  return {
    engine: latest('engine'),
    cmcd: parts.some((p) => p.cmcd),
    cmcdClaimed: parts.some((p) => p.cmcdClaimed),
    videoCodec: latest('videoCodec'),
    width: latest('width'),
    height: latest('height'),
    decoderName: latest('decoderName'),
    hwDecoder: latest('hwDecoder'),
    watchedMs: total((p) => p.watchedMs),
    stallCount: total((p) => p.stallCount),
    stallMs: total((p) => p.stallMs),
    ...frames(parts),
    recoveryReloads: total((p) => p.recoveryReloads),
    errorCount: total((p) => p.errorCount),
    // A later sid means the viewing carried on after the error.
    unrecoveredError: last.unrecoveredError,
    bandwidthBps: last.bandwidthBps,
    variantBitrate: last.variantBitrate,
    bufferAheadS: last.bufferAheadS,
    avgBandwidthBps: weighted(parts, (p) => p.avgBandwidthBps, byWatch),
    minBandwidthBps: mins.length ? Math.min(...mins) : null,
    avgVariantBitrate: weighted(parts, (p) => p.avgVariantBitrate, byWatch),
    stallBufferAheadS: weighted(parts, (p) => p.stallBufferAheadS, byStalls),
    stallBandwidthBps: weighted(parts, (p) => p.stallBandwidthBps, byStalls),
    cmcdThroughputBps: weighted(parts, (p) => p.cmcdThroughputBps, byWatch),
    medianTranscodeSpeed: weighted(parts, (p) => p.medianTranscodeSpeed, byWatch),
    sampleCount: total((p) => p.sampleCount),
  };
}
