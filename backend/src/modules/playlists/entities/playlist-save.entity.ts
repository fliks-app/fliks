import {
  Entity,
  ManyToOne,
  JoinColumn,
  RelationId,
  Unique,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Playlist } from './playlist.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A user's bookmark of another member's playlist ("saved" à la Spotify). Read
 * access still comes from the playlist's visibility/share — this only surfaces
 * it in the saver's own playlist list. One row per (user, playlist).
 */
@Entity('playlist_saves')
@Unique(['user', 'playlist'])
@Index(['user'])
export class PlaylistSave extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((s: PlaylistSave) => s.user)
  userId: number;

  @ManyToOne(() => Playlist, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'playlistId' })
  playlist: Playlist;

  @RelationId((s: PlaylistSave) => s.playlist)
  playlistId: number;
}
