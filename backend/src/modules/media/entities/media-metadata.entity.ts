import { Entity, Column, OneToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';

@Entity('media_metadata')
export class MediaMetadata extends BaseEntity {
  @OneToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn()
  media: Media;

  @Column({ type: 'bigint', nullable: true })
  budget: number;

  @Column({ type: 'bigint', nullable: true })
  revenue: number;

  @Column({ nullable: true })
  tagline: string;

  @Column({ type: 'float', nullable: true })
  popularity: number;

  @Column({ nullable: true })
  voteCount: number;

  @Column({ nullable: true })
  originalLanguage: string;

  @Column({ type: 'jsonb', nullable: true })
  productionCountries: string[];

  @Column({ type: 'jsonb', nullable: true })
  productionCompanies: string[];

  @Column({ type: 'jsonb', nullable: true })
  videos: { key: string; site: string; type: string; name: string }[];

  @Column({ type: 'jsonb', nullable: true })
  keywords: string[];
}
