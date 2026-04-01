import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Season } from './season.entity';

@Entity('episodes')
export class Episode extends BaseEntity {
  @ManyToOne(() => Season, (season) => season.episodes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'seasonId' })
  season: Season;

  @Column()
  seasonId: number;

  @Column()
  episodeNumber: number;

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

  @Column({ default: false })
  hasFile: boolean;

  @Column({ type: 'text', nullable: true })
  stillUrl: string | null;

  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
  })
  searchVector: string;
}
