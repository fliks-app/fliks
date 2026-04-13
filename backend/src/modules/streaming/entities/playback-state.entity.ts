import { Entity, Column, ManyToOne, JoinColumn, RelationId, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { Episode } from '../../media/entities/episode.entity';

@Entity('playback_states')
// FK fields are @RelationId virtuals; reference the relation property names
// (TypeORM resolves them to the underlying join columns).
@Index(['user', 'media', 'completed'])
@Index(['user', 'completed', 'lastPlayedAt'])
@Index(['user', 'episode', 'completed'])
export class PlaybackState extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((ps: PlaybackState) => ps.user)
  userId: number;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((ps: PlaybackState) => ps.media)
  mediaId: number;

  /** Last played file — used to know which file to resume on the detail page. */
  @ManyToOne(() => MediaFile, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile | null;

  @RelationId((ps: PlaybackState) => ps.mediaFile)
  mediaFileId: number | null;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((ps: PlaybackState) => ps.episode)
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
