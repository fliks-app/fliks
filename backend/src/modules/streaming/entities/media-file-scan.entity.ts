import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import type { SourceScan } from '../transcoding/source-scan';

/** The whole-file scan of a media file, valid while its size and mtime match.
 *  Its own table: the keyframe list is never loaded with the media rows. */
@Entity('media_file_scans')
@Index('UQ_media_file_scans_media_file', ['mediaFileId'], { unique: true })
export class MediaFileScan extends BaseEntity {
  @Column()
  mediaFileId: number;

  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile?: MediaFile;

  @Column({
    type: 'bigint',
    transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
  })
  size: number;

  @Column({ type: 'double precision' })
  mtimeMs: number;

  @Column({ type: 'jsonb' })
  scan: SourceScan;
}
