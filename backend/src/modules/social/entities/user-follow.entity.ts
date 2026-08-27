import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Unique,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { FollowStatus } from '../../../common/enums';

/**
 * A one-directional follow edge. `follower` follows `following`. A follow of a
 * public profile is stored `ACCEPTED` immediately; a follow of a private
 * profile is `PENDING` until the target accepts. One row per pair — mirrors the
 * {@link PlaylistShare} join-entity shape.
 */
@Entity('user_follows')
@Unique('UQ_user_follows_pair', ['follower', 'following'])
@Index('IDX_user_follows_follower', ['follower'])
@Index('IDX_user_follows_following', ['following'])
export class UserFollow extends BaseEntity {
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'followerId' })
  follower: User;

  @RelationId((f: UserFollow) => f.follower)
  followerId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'followingId' })
  following: User;

  @RelationId((f: UserFollow) => f.following)
  followingId: number;

  @Column({
    type: 'enum',
    enum: FollowStatus,
    default: FollowStatus.ACCEPTED,
  })
  status: FollowStatus;
}
