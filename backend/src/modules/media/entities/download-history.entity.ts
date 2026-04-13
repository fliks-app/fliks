import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
import { Indexer } from '../../indexers/entities/indexer.entity';
import { DownloadClient } from '../../download-clients/entities/download-client.entity';

@Entity('download_history')
export class DownloadHistory extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((dh: DownloadHistory) => dh.media)
  mediaId: number;

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
  status: string;

  @Column({ type: 'text', nullable: true })
  statusMessage: string;

  /**
   * Whether this grab was initiated automatically by the system (missing search,
   * quality upgrade, scheduler) or picked manually by a user via the download modal.
   * Used by the stalled-cleanup job to decide whether re-grab after removal.
   */
  @Column({ type: 'varchar', length: 8, default: 'auto' })
  grabSource: 'auto' | 'manual';
}
