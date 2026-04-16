import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { Episode } from '../../media/entities/episode.entity';

@Entity('download_tasks')
@Index(['user', 'deviceId', 'status'])
export class DownloadTask extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((dt: DownloadTask) => dt.user)
  userId: number;

  /** UUID identifying the device that created this download */
  @Column({ nullable: true })
  deviceId: string;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((dt: DownloadTask) => dt.media)
  mediaId: number;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((dt: DownloadTask) => dt.episode)
  episodeId: number;

  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @RelationId((dt: DownloadTask) => dt.mediaFile)
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

  // ---------------------------------------------------------------------------
  // Progressive download (HLS segments downloaded as they're transcoded)
  // ---------------------------------------------------------------------------

  /** Number of HLS segments written so far (updated every ~1s during transcode). */
  @Column({ type: 'int', nullable: true })
  segmentCount: number | null;

  /** Estimated total segments: ceil(duration / segmentDuration). */
  @Column({ type: 'int', nullable: true })
  totalSegments: number | null;

  /** HLS segment duration in seconds (from admin settings, typically 3). */
  @Column({ type: 'float', nullable: true })
  segmentDuration: number | null;

  /** Absolute path to the session directory containing init.mp4 + seg-NNNN.m4s files. */
  @Column({ type: 'varchar', nullable: true })
  sessionDir: string | null;
}
