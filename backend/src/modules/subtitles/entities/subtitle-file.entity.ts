import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../../common/enums';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';

@Entity('subtitle_files')
export class SubtitleFile extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @Column()
  mediaId: number;

  @Column({ nullable: true })
  episodeId: number;

  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @Column()
  mediaFileId: number;

  @Column()
  language: string;

  @Column({ default: false })
  forced: boolean;

  @Column({ default: false })
  hearingImpaired: boolean;

  @Column({ type: 'enum', enum: SubtitleProviderType })
  providerType: SubtitleProviderType;

  @Column({ nullable: true })
  providerFileId: string;

  /** Path relative to Media.path (same convention as MediaFile.relativePath). DB column remains `filePath`. */
  @Column({ name: 'filePath', type: 'varchar', nullable: true })
  relativePath: string | null;

  @Column({
    type: 'enum',
    enum: SubtitleStatus,
    default: SubtitleStatus.DOWNLOADED,
  })
  status: SubtitleStatus;

  @Column({ type: 'int', nullable: true })
  streamIndex: number | null;

  @Column({ type: 'varchar', nullable: true })
  codec: string | null;

  @Column({ type: 'int', default: 0 })
  score: number;

  @Column({ default: false })
  synced: boolean;

  @Column({ type: 'int', nullable: true })
  syncOffset: number;

  @Column({ default: false })
  locked: boolean;

  @Column('simple-json', { default: '[]' })
  tags: string[];
}
