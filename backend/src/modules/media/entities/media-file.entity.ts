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

  /**
   * OpenSubtitles movie hash (first + last 64 KiB summed as uint64 + size).
   * Computed once on import / rescan and forwarded to provider lookups so
   * subs returned by an OS hash search can be flagged `hashMatched` by the
   * orchestrator — the scorer treats that as a near-perfect identification.
   * Nullable when the file is smaller than 128 KiB or unreadable.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  osdbHash: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: {
      to: (v: number | null) => v,
      from: (v: string | null) => (v == null ? null : Number(v)),
    },
  })
  osdbBytesize: number | null;
}
