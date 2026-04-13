import { Entity, ManyToOne, JoinColumn, RelationId, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Library } from './library.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Junction granting a user access to a library. Non-admin users only see
 * media from libraries they have an access row for.
 *
 * A plain entity rather than a ManyToMany relation so future per-pair
 * settings (e.g. notification preferences) can be added without a migration.
 */
@Entity('library_user_access')
// `libraryId`/`userId` are @RelationId virtuals; reference the relation
// properties so TypeORM resolves them through @JoinColumn metadata.
@Unique(['library', 'user'])
export class LibraryUserAccess extends BaseEntity {
  @ManyToOne(() => Library, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'libraryId' })
  library: Library;

  @RelationId((a: LibraryUserAccess) => a.library)
  libraryId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((a: LibraryUserAccess) => a.user)
  userId: number;
}
