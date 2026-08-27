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
@Unique('UQ_playlist_saves_pair', ['user', 'playlist'])
@Index('IDX_playlist_saves_user', ['user'])
export class PlaylistSave extends BaseEntity {
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((s: PlaylistSave) => s.user)
  userId: number;

  @ManyToOne(() => Playlist, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'playlistId' })
  playlist: Playlist;

  @RelationId((s: PlaylistSave) => s.playlist)
  playlistId: number;
}
