import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';

@Entity('playback_states')
@Index(['userId', 'mediaId', 'completed'])
@Index(['userId', 'completed', 'lastPlayedAt'])
@Index(['userId', 'episodeId', 'completed'])
export class PlaybackState extends BaseEntity {
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

  /** Last played file — used to know which file to resume on the detail page. */
  @ManyToOne(() => MediaFile, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @Column({ nullable: true })
  mediaFileId: number;

  @Column({ nullable: true })
  episodeId: number;

  @Column({ type: 'float', default: 0 })
  positionSeconds: number;

  @Column({ type: 'float', default: 0, nullable: true })
  durationSeconds: number;

  @Column({ default: false })
  completed: boolean;

  @Column({ default: false })
  hiddenFromContinueWatching: boolean;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  lastPlayedAt: Date;
}
