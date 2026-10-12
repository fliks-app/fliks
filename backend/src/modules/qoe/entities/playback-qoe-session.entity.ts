import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { TranscodeReason } from '../../streaming/dto/playback-info.dto';
import type { QoeEngine, QoeVerdict, StallCause } from '../core/types';

/** One row per playback session, upserted while it runs and on its end. */
@Entity('playback_qoe_sessions')
@Index('IDX_playback_qoe_sessions_last_seen', ['lastSeenAt'])
@Index('IDX_playback_qoe_sessions_playback_verdict', ['playbackVerdict'])
@Index('IDX_playback_qoe_sessions_device', ['deviceLabel'])
@Index('IDX_playback_qoe_sessions_playback', ['userId', 'playbackId'])
export class PlaybackQoeSession {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  sessionId: string;

  /** Client id of one viewing, unique per user; several sids (quality switch, recovery) share it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  playbackId: string | null;

  @Column({ type: 'int', nullable: true })
  userId: number | null;

  @Column({ type: 'int', nullable: true })
  mediaFileId: number | null;

  @Column({ type: 'varchar', nullable: true })
  mediaTitle: string | null;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  deviceLabel: string | null;

  @Column({ type: 'varchar', nullable: true })
  systemName: string | null;

  @Column({ type: 'varchar', nullable: true })
  appVersion: string | null;

  @Column({ type: 'varchar', nullable: true })
  engine: QoeEngine | null;

  @Column({ type: 'boolean', default: false })
  cmcd: boolean;

  /** The client says it sends CMCD; `cmcd` is what the server actually parsed. */
  @Column({ type: 'boolean', default: false })
  cmcdClaimed: boolean;

  /** `transcode` | `remux` | `directplay`. */
  @Column({ type: 'varchar', nullable: true })
  playMethod: string | null;

  @Column({ type: 'varchar', nullable: true })
  quality: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  transcodeReasons: TranscodeReason[];

  @Column({ type: 'varchar', nullable: true })
  videoCodec: string | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', nullable: true })
  decoderName: string | null;

  @Column({ type: 'boolean', nullable: true })
  hwDecoder: boolean | null;

  @Column({ type: 'int', default: 0 })
  watchedMs: number;

  @Column({ type: 'int', default: 0 })
  stallCount: number;

  @Column({ type: 'int', default: 0 })
  stallMs: number;

  @Column({ type: 'int', nullable: true })
  droppedFrames: number | null;

  @Column({ type: 'int', nullable: true })
  decodedFrames: number | null;

  @Column({ type: 'double precision', nullable: true })
  avgBandwidthBps: number | null;

  @Column({ type: 'double precision', nullable: true })
  minBandwidthBps: number | null;

  @Column({ type: 'double precision', nullable: true })
  avgVariantBitrate: number | null;

  @Column({ type: 'int', default: 0 })
  recoveryReloads: number;

  @Column({ type: 'int', default: 0 })
  errorCount: number;

  @Column({ type: 'double precision', nullable: true })
  medianTranscodeSpeed: number | null;

  /** Inputs `diagnose()` needs to re-run on several rows merged into one playback. */
  @Column({ type: 'double precision', nullable: true })
  stallBufferAheadS: number | null;

  @Column({ type: 'double precision', nullable: true })
  stallBandwidthBps: number | null;

  @Column({ type: 'double precision', nullable: true })
  cmcdThroughputBps: number | null;

  @Column({ type: 'boolean', default: false })
  unrecoveredError: boolean;

  @Column({ type: 'int', default: 0 })
  sampleCount: number;

  @Column({ type: 'varchar', default: 'unknown' })
  verdict: QoeVerdict;

  @Column({ type: 'varchar', default: 'low' })
  confidence: 'high' | 'low';

  @Column({ type: 'jsonb', default: () => `'[]'` })
  reasons: string[];

  /** Verdict of the whole playback (all rows of this user and playbackId), rewritten at flush. */
  /** Stalled ms per classified cause; null when no stall was classified. */
  @Column({ type: 'jsonb', nullable: true })
  stallCauseMs: Record<StallCause, number> | null;

  @Column({ type: 'varchar', default: 'unknown' })
  playbackVerdict: QoeVerdict;

  @Column({ type: 'varchar', default: 'low' })
  playbackConfidence: 'high' | 'low';
}
