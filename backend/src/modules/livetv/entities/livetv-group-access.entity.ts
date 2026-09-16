import { Entity, Column, ManyToOne, JoinColumn, RelationId, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Which channel groups a user may see, mirroring `LibraryUserAccess`. A user
 * with no row here sees every group that is not restricted; a user with rows
 * sees only those. Hiding a channel is the viewer's own preference and is not
 * a control: this is.
 */
@Entity('livetv_group_access')
@Index('UQ_livetv_group_access_user_group', ['user', 'groupName'], { unique: true })
export class LiveTvGroupAccess extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((a: LiveTvGroupAccess) => a.user)
  userId: number;

  @Column({ type: 'varchar' })
  groupName: string;
}
