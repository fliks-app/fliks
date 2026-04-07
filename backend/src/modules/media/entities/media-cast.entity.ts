import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
import { Person } from './person.entity';

@Entity('media_cast')
@Index(['media'])
@Index(['person'])
export class MediaCast extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn()
  media: Media;

  @ManyToOne(() => Person, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn()
  person: Person;

  @Column()
  character: string;

  @Column()
  order: number;
}
