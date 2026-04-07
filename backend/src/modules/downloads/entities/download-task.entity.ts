import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';

@Entity('download_tasks')
@Index(['userId', 'status'])
export class DownloadTask extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  userId: number;

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

  /** 'original' | '1080p' | '720p' | '480p' */
  @Column()
  quality: string;

  /** pending | transcoding | remuxing | ready | failed */
  @Column({ default: 'pending' })
  status: string;

  /** 0-100 transcode/remux progress */
  @Column({ type: 'float', default: 0 })
  progress: number;

  /** Path to output file (transcoded/remuxed). Null if original direct serve. */
  @Column({ nullable: true })
  outputPath: string;

  /** Final file size in bytes */
  @Column({ type: 'bigint', nullable: true })
  fileSize: number;

  /** e.g. "S02E05 - Tout regarder brûler" */
  @Column({ nullable: true })
  episodeLabel: string;

  /** Set when client confirms it has downloaded the file. Server can cleanup outputPath after this. */
  @Column({ type: 'timestamptz', nullable: true })
  clientDownloadedAt: Date | null;

  /** Extracted VTT subtitle files — for offline playback */
  @Column({ type: 'jsonb', nullable: true })
  subtitles: { language: string; forced: boolean; filename: string }[];

  @Column({ nullable: true })
  error: string;
}
