import { Entity, Column, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';

@Entity('playback_states')
@Unique(['userId', 'mediaFileId'])
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

  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @Column()
  mediaFileId: number;

  @Column({ nullable: true })
  episodeId: number;

  @Column({ type: 'float', default: 0 })
  positionSeconds: number;

  @Column({ type: 'float', default: 0, nullable: true })
  durationSeconds: number;

  @Column({ default: false })
  completed: boolean;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  lastPlayedAt: Date;
}
