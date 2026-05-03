import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Unique,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Episode } from '../../media/entities/episode.entity';

export type MarkerType = 'intro' | 'outro' | 'recap';

/**
 * Per-episode time marker for skip-intro / skip-credits / recap features.
 *
 * One marker per (episode, type) — enforced by the @Unique constraint.
 * Detected automatically by IntroDetectionService (audio fingerprint matching
 * across episodes of a season) or edited manually by an admin.
 */
@Entity('episode_markers')
@Unique('uq_episode_marker_type', ['episode', 'type'])
export class EpisodeMarker extends BaseEntity {
  @ManyToOne(() => Episode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode;

  @RelationId((m: EpisodeMarker) => m.episode)
  episodeId: number;

  @Column({ type: 'varchar', length: 16 })
  type: MarkerType;

  @Column({ type: 'float' })
  startSeconds: number;

  @Column({ type: 'float' })
  endSeconds: number;

  /** 0–1 fingerprint match confidence. 1 for manual entries. */
  @Column({ type: 'float', default: 1 })
  confidence: number;

  /** True for user-edited markers — auto-detection skips these to preserve overrides. */
  @Column({ default: false })
  manual: boolean;
}
