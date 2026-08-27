import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { Season } from '../../media/entities/season.entity';
import { Episode } from '../../media/entities/episode.entity';

/**
 * One member recommending a piece of content to another: a movie (media only),
 * a season (media + season) or an episode (media + episode). `media` is always
 * the parent title, so recommendations stay scoped to a library. The recipient
 * dismisses it once handled (`dismissedAt`), which hides it from their home /
 * library sections without deleting the row.
 */
@Entity('content_recommendations')
@Index('IDX_content_recommendations_recipient', ['recipient'])
export class ContentRecommendation extends BaseEntity {
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'senderId' })
  sender: User;

  @RelationId((r: ContentRecommendation) => r.sender)
  senderId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipientId' })
  recipient: User;

  @RelationId((r: ContentRecommendation) => r.recipient)
  recipientId: number;

  /** The movie, or the parent series for a season/episode recommendation. */
  @ManyToOne(() => Media, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((r: ContentRecommendation) => r.media)
  mediaId: number;

  @ManyToOne(() => Season, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seasonId' })
  season: Season | null;

  @RelationId((r: ContentRecommendation) => r.season)
  seasonId: number | null;

  @ManyToOne(() => Episode, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((r: ContentRecommendation) => r.episode)
  episodeId: number | null;

  /** Optional note from the sender. */
  @Column({ type: 'text', nullable: true })
  message: string | null;

  /** Set when the recipient dismisses the recommendation. */
  @Column({ type: 'timestamptz', nullable: true })
  dismissedAt: Date | null;
}
