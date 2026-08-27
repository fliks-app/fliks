import {
  Entity,
  ManyToOne,
  JoinColumn,
  RelationId,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { Season } from '../../media/entities/season.entity';
import { Episode } from '../../media/entities/episode.entity';

/**
 * A user's "like" on a piece of content: a movie (media only), a season
 * (media + season) or an episode (media + episode). `media` is always the
 * parent title, so likes stay scoped to a library.
 */
@Entity('likes')
@Index('IDX_likes_user', ['user'])
// One like per granularity (movie/series, season, episode). Declared here so dev
// `synchronize` matches the migration — a plain @Unique can't express the NULL split.
@Index('UQ_likes_movie', ['user', 'media'], {
  unique: true,
  where: '(("seasonId" IS NULL) AND ("episodeId" IS NULL))',
})
@Index('UQ_likes_season', ['user', 'season'], {
  unique: true,
  where: '("seasonId" IS NOT NULL)',
})
@Index('UQ_likes_episode', ['user', 'episode'], {
  unique: true,
  where: '("episodeId" IS NOT NULL)',
})
export class Like extends BaseEntity {
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((l: Like) => l.user)
  userId: number;

  /** The movie, or the parent series for a season/episode like. */
  @ManyToOne(() => Media, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((l: Like) => l.media)
  mediaId: number;

  @ManyToOne(() => Season, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seasonId' })
  season: Season | null;

  @RelationId((l: Like) => l.season)
  seasonId: number | null;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((l: Like) => l.episode)
  episodeId: number | null;
}
