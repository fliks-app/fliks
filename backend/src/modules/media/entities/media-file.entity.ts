import { Entity, Column, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';

@Entity('media_files')
@Unique(['mediaId', 'relativePath'])
export class MediaFile extends BaseEntity {
  @ManyToOne(() => Media, (media) => media.files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @Column()
  mediaId: number;

  @Column({ nullable: true })
  episodeId: number;

  @Column()
  relativePath: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column()
  quality: string;

  @Column({ nullable: true })
  language: string;

  @Column({ type: 'jsonb', nullable: true, default: null })
  streamInfo: any;
}
