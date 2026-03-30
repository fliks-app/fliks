import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('tags')
export class Tag extends BaseEntity {
  @Column({ unique: true })
  label: string;
}
