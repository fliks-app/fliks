import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * Records a user-explicit "remove from recommendations" gesture. The
 * RecommendationService merges these into its exclusion set so the
 * dismissed media never resurfaces in the row, even if the genre profile
 * still scores it highly.
 *
 * One row per (user, media). The unique index makes the dismiss endpoint
 * idempotent — repeated calls are no-ops.
 */
@Entity('recommendation_dismissals')
@Index('UQ_recommendation_dismissals_user_media', ['userId', 'mediaId'], {
  unique: true,
})
export class RecommendationDismissal extends BaseEntity {
  @Column()
  @Index()
  userId: number;

  @Column()
  mediaId: number;
}
