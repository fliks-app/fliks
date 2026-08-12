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

@Entity('playback_states')
// FK fields are @RelationId virtuals; reference the relation property names
// (TypeORM resolves them to the underlying join columns).
@Index(['user', 'media', 'completed'])
@Index(['user', 'completed', 'lastPlayedAt'])
@Index(['user', 'episode', 'completed'])
// One row per user+movie and per user+episode. Two partial indexes rather than one
// composite: `episodeId IS NULL` is what separates a movie row from an episode row,
// and NULLs never collide in a plain unique index.
@Index('idx_playback_user_movie', ['user', 'media'], { unique: true, where: '"episodeId" IS NULL' })
@Index('idx_playback_user_episode', ['user', 'episode'], { unique: true, where: '"episodeId" IS NOT NULL' })
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
  @ManyToOne(() => MediaFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaFileId' })
  mediaFile: MediaFile;

  @RelationId((ps: PlaybackState) => ps.mediaFile)
  mediaFileId: number;

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

  /**
   * Set only when real playback progress occurs. Stays NULL for manual
   * "mark as watched" actions (single or bulk season). Used by the history
   * endpoint to distinguish actually-watched rows from manually-marked ones.
   */
  @Column({ type: 'timestamptz', nullable: true })
  playedAt: Date | null;
}
