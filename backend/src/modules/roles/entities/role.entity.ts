import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('roles')
export class Role extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column('simple-json', { default: '[]' })
  permissions: string[];

  /** The role assigned to new users by default. */
  @Column({ default: false })
  isDefault: boolean;
}
