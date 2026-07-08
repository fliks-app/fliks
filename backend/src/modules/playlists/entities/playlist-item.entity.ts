import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Playlist } from './playlist.entity';
import { Media } from '../../media/entities/media.entity';
import { Episode } from '../../media/entities/episode.entity';
import { User } from '../../users/entities/user.entity';

/**
 * One entry in a playlist: a movie (`episode` null, `media` is the movie) or a
 * single episode (`media` is the parent series, `episode` set). A plain
 * junction (not @ManyToMany) because it carries `position` and the "who added
 * it" attribution. Uniqueness is enforced by partial unique indexes in the
 * migration — one row per (playlist, movie) and one per (playlist, episode).
 */
@Entity('playlist_items')
// Partial unique indexes (also created by the migration) so a movie appears at
// most once and an episode at most once per playlist. Declared here too so dev
// `synchronize` matches prod — a plain @Unique can't express the NULL split.
@Index('UQ_playlist_items_movie', ['playlist', 'media'], {
  unique: true,
  where: '"episodeId" IS NULL',
})
@Index('UQ_playlist_items_episode', ['playlist', 'episode'], {
  unique: true,
  where: '"episodeId" IS NOT NULL',
})
export class PlaylistItem extends BaseEntity {
  @ManyToOne(() => Playlist, (playlist) => playlist.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'playlistId' })
  playlist: Playlist;

  @RelationId((i: PlaylistItem) => i.playlist)
  playlistId: number;

  /** The movie, or the parent series when this item is an episode. */
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @RelationId((i: PlaylistItem) => i.media)
  mediaId: number;

  /** Set when the item is a single episode; null for a movie item. */
  @ManyToOne(() => Episode, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode | null;

  @RelationId((i: PlaylistItem) => i.episode)
  episodeId: number | null;

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
