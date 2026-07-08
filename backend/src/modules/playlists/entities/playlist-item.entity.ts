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
import { Media } from '../../media/entities/media.entity';
import { User } from '../../users/entities/user.entity';

/**
 * One media entry in a playlist. A plain junction (not @ManyToMany) because it
 * carries `position` and the "who added it" attribution. `@Unique` keeps a
 * given media from appearing twice in the same playlist.
 */
@Entity('playlist_items')
@Unique(['playlist', 'media'])
export class PlaylistItem extends BaseEntity {
  @ManyToOne(() => Playlist, (playlist) => playlist.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'playlistId' })
  playlist: Playlist;

  @RelationId((i: PlaylistItem) => i.playlist)
  playlistId: number;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((i: PlaylistItem) => i.media)
  mediaId: number;

  /** Ascending order within the playlist; the first four feed the cover. */
  @Column({ type: 'int' })
  position: number;

  /**
   * Who added the item (attribution on shared playlists). SET NULL rather than
   * CASCADE so removing the adder keeps the item in the owner's playlist.
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'addedById' })
  addedBy: User | null;

  @RelationId((i: PlaylistItem) => i.addedBy)
  addedById: number | null;
}
