import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Unique,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Playlist } from './playlist.entity';
import { User } from '../../users/entities/user.entity';
import { PlaylistShareRole } from '../../../common/enums';

/**
 * Grants a non-owner user a role on a playlist. The owner is never represented
 * here (it lives on {@link Playlist}.owner), which is what makes the
 * "owner can never be removed" rule structural.
 */
@Entity('playlist_shares')
@Unique(['playlist', 'user'])
export class PlaylistShare extends BaseEntity {
  @ManyToOne(() => Playlist, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'playlistId' })
  playlist: Playlist;

  @RelationId((s: PlaylistShare) => s.playlist)
  playlistId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((s: PlaylistShare) => s.user)
  userId: number;

  @Column({
    type: 'enum',
    enum: PlaylistShareRole,
    default: PlaylistShareRole.VIEWER,
  })
  role: PlaylistShareRole;
}
