import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../../common/enums';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { Episode } from '../../media/entities/episode.entity';

@Entity('subtitle_files')
export class SubtitleFile extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((sf: SubtitleFile) => sf.media)
  mediaId: number;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((sf: SubtitleFile) => sf.episode)
  episodeId: number;

  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @RelationId((sf: SubtitleFile) => sf.mediaFile)
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

  /**
   * True when the candidate this row was downloaded from came out of a
   * hash-based provider lookup (e.g. OpenSubtitles moviehash). Used by
   * the upgrade pass as a guard: a hash-matched sub is the perfect time
   * sync, so non-hash candidates can't replace it on score alone.
   */
  @Column({ default: false })
  hashMatched: boolean;

  @Column({ default: false })
  synced: boolean;

  @Column({ type: 'int', nullable: true })
  syncOffset: number;

  @Column({ default: false })
  locked: boolean;

  @Column('simple-json', { default: '[]' })
  tags: string[];
}
