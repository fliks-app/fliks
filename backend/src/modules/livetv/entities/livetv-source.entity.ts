import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export type LiveTvSourceKind = 'm3u' | 'xtream';
export type LiveTvSyncStatus = 'never' | 'ok' | 'error';

/**
 * One provider connection. `maxStreams` caps upstream connections rather than
 * viewers: a channel someone already watches costs nothing to join.
 */
@Entity('livetv_sources')
export class LiveTvSource extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'varchar', length: 16, default: 'm3u' })
  kind: LiveTvSourceKind;

  /** Playlist URL for `m3u`, panel base URL for `xtream`. */
  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  username: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  password: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  userAgent: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  referer: string | null;

  /** 0 means no known limit. Auto-filled from the panel on sync, unless
   *  `maxStreamsIsManual` says an admin already typed a value here. */
  @Column({ type: 'int', default: 0 })
  maxStreams: number;

  @Column({ type: 'boolean', default: false })
  maxStreamsIsManual: boolean;

  @Column({ type: 'int', default: 12 })
  refreshIntervalHours: number;

  /** Case-insensitive regex against `group-title`; null means no restriction. */
  @Column({ type: 'text', nullable: true, default: null })
  includeGroupsPattern: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  excludeGroupsPattern: string | null;

  /** From the panel (`exp_date`) or a plain playlist's `billed-till` header. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  expiresAt: Date | null;

  /** The panel's own `status` field (Xtream only). */
  @Column({ type: 'varchar', nullable: true, default: null })
  accountStatus: string | null;

  /** `x-tvg-url` / `url-tvg`, captured at sync time so a guide refresh never
   *  has to re-download the whole playlist just to read one header. */
  @Column({ type: 'jsonb', default: [] })
  guideUrls: string[];

  @Column({ type: 'varchar', nullable: true, default: null })
  playlistEtag: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  playlistLastModified: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Lower wins when several sources carry the same channel. */
  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastSyncAt: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'never' })
  lastSyncStatus: LiveTvSyncStatus;

  @Column({ type: 'text', nullable: true, default: null })
  lastSyncError: string | null;

  @Column({ type: 'int', default: 0 })
  channelCount: number;
}
