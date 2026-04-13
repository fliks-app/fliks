import { Entity, Column, ManyToOne, OneToMany, JoinColumn, RelationId } from 'typeorm';
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

  @OneToMany(() => Episode, (episode) => episode.season, { cascade: true })
  episodes: Episode[];
}
