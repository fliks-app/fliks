import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { QoeEngine, QoeVerdict } from '../core/types';

/** One row per playback session, upserted while it runs and on its end. */
@Entity('playback_qoe_sessions')
@Index('IDX_playback_qoe_sessions_last_seen', ['lastSeenAt'])
@Index('IDX_playback_qoe_sessions_verdict', ['verdict'])
@Index('IDX_playback_qoe_sessions_device', ['deviceLabel'])
export class PlaybackQoeSession {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  sessionId: string;

  @Column({ type: 'int', nullable: true })
  userId: number | null;

  @Column({ type: 'int' })
  mediaFileId: number;

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

  /** `transcode` | `remux` | `directplay`. */
  @Column({ type: 'varchar', nullable: true })
  playMethod: string | null;

  @Column({ type: 'varchar', nullable: true })
  quality: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  transcodeReasons: unknown[];

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

  @Column({ type: 'varchar', default: 'unknown' })
  verdict: QoeVerdict;

  @Column({ type: 'varchar', default: 'low' })
  confidence: 'high' | 'low';

  @Column({ type: 'jsonb', default: () => `'[]'` })
  reasons: string[];
}
