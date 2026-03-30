import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('root_folders')
export class RootFolder extends BaseEntity {
  @Column({ unique: true })
  path: string;

  @Column({ nullable: true })
  label: string;
}
