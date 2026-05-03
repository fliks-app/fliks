import { Entity, Column, ManyToMany, JoinTable, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Library } from '../../libraries/entities/library.entity';

@Entity('roles')
export class Role extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column('simple-json', { default: '[]' })
  permissions: string[];

  /** The role assigned to new users by default. */
  @Column({ default: false })
  isDefault: boolean;

  /**
   * Libraries new users with this role inherit on creation. Used as a template
   * only — after creation, each user's library access is managed independently
   * via {@link LibraryUserAccess}. Real ManyToMany so deleting a library
   * cascades the junction row away (no orphan IDs).
   */
  @ManyToMany(() => Library, { onDelete: 'CASCADE' })
  @JoinTable({
    name: 'role_default_libraries',
    joinColumn: { name: 'roleId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'libraryId', referencedColumnName: 'id' },
  })
  defaultLibraries: Library[];

  /** Fast read access to the IDs without joining (TypeORM populates after load). */
  @RelationId((role: Role) => role.defaultLibraries)
  defaultLibraryIds: number[];
}
