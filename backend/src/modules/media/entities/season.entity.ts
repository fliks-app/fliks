import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
import { Episode } from './episode.entity';

@Entity('seasons')
export class Season extends BaseEntity {
  @ManyToOne(() => Media, (media) => media.seasons, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((s: Season) => s.media)
  mediaId: number;

  @Column()
  seasonNumber: number;

  @Column({ default: true })
  monitored: boolean;

  /**
   * Override of the media/library metadata provider for this season. Matched
   * by seasonNumber against the override provider — if TMDB and TVDB disagree
   * on numbering (anthologies, DVD order, …), the lookup may silently return
   * nothing and a warning is logged. `null` → inherit.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  preferredProvider: string | null;

  @OneToMany(() => Episode, (episode) => episode.season, { cascade: true })
  episodes: Episode[];
}
