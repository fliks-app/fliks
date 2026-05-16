import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Unique,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { Media } from './media.entity';
import { Episode } from './episode.entity';

@Entity('media_files')
@Unique(['media', 'relativePath'])
export class MediaFile extends BaseEntity {
  @ManyToOne(() => Media, (media) => media.files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((mf: MediaFile) => mf.media)
  mediaId: number;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((mf: MediaFile) => mf.episode)
  episodeId: number;

  @Column()
  relativePath: string;

  @Column({
    type: 'bigint',
    transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
  })
  size: number;

  @Column()
  quality: string;

  @Column({ nullable: true })
  language: string;

  @Column({ type: 'jsonb', nullable: true, default: null })
  streamInfo: MediaFileInfo | null;
}
