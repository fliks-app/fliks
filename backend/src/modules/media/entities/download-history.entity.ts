import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
import { Episode } from './episode.entity';
import { Season } from './season.entity';
import { Indexer } from '../../../plugins/download/indexers/entities/indexer.entity';
import { DownloadClient } from '../../../plugins/download/download-clients/entities/download-client.entity';

/** Canonical lifecycle of a {@link DownloadHistory} row. */
export const DOWNLOAD_HISTORY_STATUSES = [
  'grabbed',
  'importing',
  'completed',
  'failed',
  'warning',
] as const;
export type DownloadHistoryStatus = (typeof DOWNLOAD_HISTORY_STATUSES)[number];

/** Whether the grab was triggered by a user (manual) or by the scheduler (auto). */
export type GrabSource = 'auto' | 'manual';

@Entity('download_history')
export class DownloadHistory extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((dh: DownloadHistory) => dh.media)
  mediaId: number;

  /**
   * Optional episode link. Set when the grabbed/auto-matched torrent
   * targets a single episode (\`Show.S01E03\`). Null for season packs,
   * movies, and torrents whose name didn't surface a specific episode.
   * SET NULL on delete so a removed episode doesn't take the history
   * row with it (the media reference must survive — see the "never
   * unlink" invariant).
   */
  @ManyToOne(() => Episode, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((dh: DownloadHistory) => dh.episode)
  episodeId: number | null;

  /**
   * Optional season link. Set when the grabbed/auto-matched torrent
   * targets a whole season (\`Show.S01\`) or a single episode (in
   * which case the season is the episode's parent — stored for direct
   * lookup so the UI doesn't need a JOIN).
   */
  @ManyToOne(() => Season, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'seasonId' })
  season: Season | null;

  @RelationId((dh: DownloadHistory) => dh.season)
  seasonId: number | null;

  @ManyToOne(() => Indexer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'indexerId' })
  indexer: Indexer | null;

  @RelationId((dh: DownloadHistory) => dh.indexer)
  indexerId: number;

  @ManyToOne(() => DownloadClient, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'downloadClientId' })
  downloadClient: DownloadClient | null;

  @RelationId((dh: DownloadHistory) => dh.downloadClient)
  downloadClientId: number;

  @Column()
  sourceTitle: string;

  @Column()
  quality: string;

  @Column({ nullable: true })
  language: string;

  @Column({ nullable: true })
  torrentHash: string;

  @Column({ default: 'grabbed' })
  status: DownloadHistoryStatus;

  @Column({ type: 'text', nullable: true })
  statusMessage: string;

  /**
   * Whether this grab was initiated automatically by the system (missing search,
   * quality upgrade, scheduler) or picked manually by a user via the download modal.
   * Used by the stalled-cleanup job to decide whether re-grab after removal.
   */
  @Column({ type: 'varchar', length: 8, default: 'auto' })
  grabSource: GrabSource;
}
