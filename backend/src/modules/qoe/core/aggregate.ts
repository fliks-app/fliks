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
/** Bounds memory on a multi-hour session. */
const MAX_KEPT = 200;

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
  private minBuffer: number | null = null;
  private readonly stallBuffers: number[] = [];
  private readonly stallBandwidths: number[] = [];
  private readonly cmcdMtp: number[] = [];
  private readonly speeds: number[] = [];
  private readonly sendBps: number[] = [];
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
    if (s.cmcd) this.cmcdSeen = true;
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
      this.noteBuffer(s.bufferAheadS);
    }
  }

  addEvent(e: QoeEvent, now: number): void {
    if (e.type === 'stall') {
      if (e.bufferAheadS != null) push(this.stallBuffers, e.bufferAheadS);
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
    if (m.bytes != null && m.sendMs != null && m.bytes > 0 && m.sendMs > 0) {
      push(this.sendBps, (m.bytes * 8000) / m.sendMs);
    }
  }

  addCmcd(c: CmcdSnapshot): void {
    this.cmcdSeen = true;
    if (c.mtp != null) push(this.cmcdMtp, c.mtp * 1000);
    if (c.bl != null) this.noteBuffer(c.bl / 1000);
    if (c.br != null && this.variantBitrates.length === 0) {
      this.variantBitrate = c.br * 1000;
    }
  }

  private noteBuffer(s: number): void {
    this.minBuffer = Math.min(this.minBuffer ?? Infinity, s);
  }

  summary(): QoeSessionSummary {
    const lastErrorAt = this.lastErrorAt;
    return {
      engine: this.engine,
      cmcd: this.cmcdSeen,
      videoCodec: this.videoCodec,
      width: this.width,
      height: this.height,
      decoderName: this.decoderName,
      hwDecoder: this.hwDecoder,
      watchedMs: this.watchedMs,
      stallCount: this.stalls.total ?? 0,
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
      stallBufferAheadS: median(this.stallBuffers),
      stallBandwidthBps: median(this.stallBandwidths),
      minBufferAheadS: this.minBuffer,
      cmcdThroughputBps: avg(this.cmcdMtp),
      serverThroughputBps: median(this.sendBps),
      medianTranscodeSpeed:
        this.speeds.length >= MIN_SPEED_SAMPLES ? median(this.speeds) : null,
      sampleCount: this.sampleCount,
    };
  }
}
