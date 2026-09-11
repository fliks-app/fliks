import { Entity, Column, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('persons')
@Unique(['provider', 'tmdbId'])
export class Person extends BaseEntity {
  /** Provider that issued {@link tmdbId}: TVDB credits store a TVDB people id
   *  in that column, so it is only a TMDB id when this says `tmdb`. */
  @Column({ length: 16, default: 'tmdb' })
  provider: string;

  @Column()
  tmdbId: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  avatarUrl: string;

  @Column({ type: 'text', nullable: true })
  biography: string;

  @Column({ type: 'date', nullable: true })
  birthday: string;

  @Column({ type: 'date', nullable: true })
  deathday: string;

  @Column({ nullable: true })
  placeOfBirth: string;

  @Column({ nullable: true })
  knownForDepartment: string;

  @Column({ type: 'jsonb', default: '[]' })
  departments: string[];

  @Column({ type: 'timestamptz', nullable: true })
  metadataRefreshedAt: Date | null;

  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
  })
  searchVector: string;
}
