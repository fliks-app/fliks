import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('persons')
export class Person extends BaseEntity {
  @Column({ unique: true })
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

  @Column({ type: 'timestamptz', nullable: true })
  metadataRefreshedAt: Date | null;

  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
  })
  searchVector: string;
}
