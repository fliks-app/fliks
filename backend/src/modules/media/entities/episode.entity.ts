import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Season } from './season.entity';

@Entity('episodes')
export class Episode extends BaseEntity {
  @ManyToOne(() => Season, (season) => season.episodes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'seasonId' })
  season: Season;

  @RelationId((e: Episode) => e.season)
  seasonId: number;

  @Column()
  episodeNumber: number;

  /**
   * Last episode number when this row represents a multi-episode file
   * (e.g. "S07E25-E26.mkv" → episodeNumber=25, endEpisodeNumber=26).
   * One Episode row covers the range, metadata/watched/progress are
   * shared. The "shadowed" episodes (26 in the example) are
   * still created by the provider refresh but hidden by the UI so they
   * don't show up as "missing". `null` for normal single-episode files.
   */
  @Column({ type: 'int', nullable: true, default: null })
  endEpisodeNumber: number | null;

  @Column({ nullable: true })
  title: string;

  @Column({ type: 'text', nullable: true })
  overview: string;

  @Column({ type: 'date', nullable: true })
  airDate: string;

  @Column({ type: 'int', nullable: true })
  runtime: number | null;

  @Column({ default: true })
  monitored: boolean;

  /** True when this episode has its OWN media file. Drives playback, intro
   *  detection and watched tracking — things that need a directly playable
   *  file. A shadowed episode of a multi-episode file stays `false` here; its
   *  "on disk" status is derived via `episode-coverage.util` (coverage), not
   *  stored. */
  @Column({ default: false })
  hasFile: boolean;

  @Column({ type: 'text', nullable: true })
  stillUrl: string | null;

  /** Set after intro/outro detection runs — prevents re-scanning episodes where detection found nothing. */
  @Column({ type: 'timestamptz', nullable: true })
  markersScannedAt: Date | null;

  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
  })
  searchVector: string;
}
