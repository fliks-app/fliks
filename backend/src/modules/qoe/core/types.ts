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
  /** Client-generated id, stable across the sids of one viewing. */
  playbackId?: string | null;
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
  /** Stall: the active variant bitrate (bps) when it began. */
  variantBitrate?: number;
}

export type StallCause = 'server' | 'network' | 'device' | 'unknown';

export interface StallClassification {
  cause: StallCause;
  confidence: 'high' | 'low';
  /** i18n key, `qoe.stall.*`. */
  reason: string;
  evidence: Record<string, number>;
}

/** What the server adds to a stall event's data once it has classified it. */
export interface StallCauseData {
  cause: StallCause;
  causeConfidence: 'high' | 'low';
  causeReason: string;
  causeEvidence: Record<string, number>;
}

/** A served segment with the server time it finished waiting. */
export interface StallSegment {
  at: number;
  segmentDurationS: number;
  waitedMs: number | null;
}

export interface StallSample {
  /** Server receive time. */
  at: number;
  droppedFrames: number | null;
  decodedFrames: number | null;
}

/** What the server knew when the stall was reported. */
export interface StallContext {
  segments: StallSegment[];
  samples: StallSample[];
  /** Fresh sample or CMCD buffer. */
  bufferAheadS: number | null;
  /** Latest sample bandwidth, else CMCD throughput. */
  bandwidthBps: number | null;
  /** Latest sample variant bitrate (a transcode's nominal rung when the client has none). */
  variantBitrate: number | null;
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
  /** Object type: video, audio or muxed. */
  ot?: 'v' | 'a' | 'av';
  su?: boolean;
}

/** One served segment: how long the request waited for ffmpeg to produce it. */
export interface SegmentMetric {
  segmentDurationS: number;
  /** Null when the segment was already on disk (no wait to measure). */
  waitedMs: number | null;
}

export type ThroughputSource = 'engine' | 'cmcd';

export interface QoeSessionSummary {
  engine: QoeEngine | null;
  /** The server parsed CMCD on a request of this session. */
  cmcd: boolean;
  /** The client says it sends CMCD; a hint only. */
  cmcdClaimed: boolean;
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
  /** CMCD `mtp` average converted to bps. */
  cmcdThroughputBps: number | null;
  /** Median of segment duration / wait; null below the sample floor. */
  medianTranscodeSpeed: number | null;
  /** Stalled ms per classified cause; null when no stall was classified. */
  stallCauseMs: Record<StallCause, number> | null;
  /** Samples received, i.e. the engine reports anything at all. */
  sampleCount: number;
}
