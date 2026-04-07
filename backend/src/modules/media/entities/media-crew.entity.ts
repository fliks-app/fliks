import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
import { Person } from './person.entity';

@Entity('media_crew')
export class MediaCrew extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn()
  media: Media;

  @ManyToOne(() => Person, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn()
  person: Person;

  @Column()
  job: string;

  @Column()
  department: string;
}
