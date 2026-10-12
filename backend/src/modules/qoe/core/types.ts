export type QoeEngine =
  | 'shaka'
  | 'exoplayer'
  | 'avplayer'
  | 'mpv'
  | 'avplay'
  | 'webos'
  | 'cast';

/** Client heartbeat sample. Counters are cumulative since the engine's last load(). */
export interface QoeSample {
  engine: QoeEngine;
  cmcd: boolean;
  droppedFrames: number | null;
  decodedFrames: number | null;
  bandwidthBps: number | null;
  bufferAheadS: number | null;
  variantBitrate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  decoderName: string | null;
  hwDecoder: boolean | null;
  stallCount: number;
  stallMs: number;
  recoveryReloads: number;
}

export type QoeEventType = 'stall' | 'error' | 'recovery' | 'quality_switch';

export interface QoeEvent {
  type: QoeEventType;
  /** Epoch ms, client clock. */
  at: number;
  position: number | null;
  durationMs?: number;
  bufferAheadS?: number | null;
  bandwidthBps?: number | null;
  code?: number;
  message?: string;
  category?: string;
  fromBitrate?: number;
  toBitrate?: number;
}

export type QoeVerdict =
  | 'ok'
  | 'network'
  | 'device'
  | 'server'
  | 'error'
  | 'unknown';

export interface QoeDiagnosis {
  verdict: QoeVerdict;
  confidence: 'high' | 'low';
  /** i18n keys, `qoe.reason.*`. */
  reasons: string[];
}

/** CMCD keys the server uses, in the units the spec defines (bl ms, mtp/br/tb kbps). */
export interface CmcdSnapshot {
  bl?: number;
  mtp?: number;
  br?: number;
  tb?: number;
  bs?: boolean;
  su?: boolean;
}

/** One served segment: how long the request waited for ffmpeg, and the send. */
export interface SegmentMetric {
  segmentDurationS: number;
  /** Null when the segment was already on disk (no wait to measure). */
  waitedMs: number | null;
  bytes: number | null;
  sendMs: number | null;
}

export type ThroughputSource = 'engine' | 'cmcd' | 'server';

export interface QoeSessionSummary {
  engine: QoeEngine | null;
  cmcd: boolean;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  decoderName: string | null;
  hwDecoder: boolean | null;
  watchedMs: number;
  stallCount: number;
  stallMs: number;
  droppedFrames: number | null;
  decodedFrames: number | null;
  recoveryReloads: number;
  errorCount: number;
  /** An error with no recovery after it and no heartbeat since. */
  unrecoveredError: boolean;
  /** Latest values, for the live view. */
  bandwidthBps: number | null;
  variantBitrate: number | null;
  bufferAheadS: number | null;
  avgBandwidthBps: number | null;
  minBandwidthBps: number | null;
  avgVariantBitrate: number | null;
  /** Medians over the stall events that reported them. */
  stallBufferAheadS: number | null;
  stallBandwidthBps: number | null;
  /** Lowest buffer-ahead seen on any sample or CMCD report. */
  minBufferAheadS: number | null;
  /** CMCD `mtp` average converted to bps. */
  cmcdThroughputBps: number | null;
  /** Median bytes*8 / send time over served segments. */
  serverThroughputBps: number | null;
  /** Median of segment duration / wait; null below the sample floor. */
  medianTranscodeSpeed: number | null;
  /** Samples received, i.e. the engine reports anything at all. */
  sampleCount: number;
}
