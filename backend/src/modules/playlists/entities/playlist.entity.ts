import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { PlaylistItem } from './playlist-item.entity';

/**
 * A user-owned, named collection of media. The owner is a column here (not a
 * share row) so it is structurally impossible to remove or demote the owner.
 * Access for other users is granted per-user through {@link PlaylistShare}.
 */
@Entity('playlists')
export class Playlist extends BaseEntity {
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @RelationId((p: Playlist) => p.owner)
  ownerId: number;

  /** Drop an item from the playlist once its watcher has finished it. */
  @Column({ default: false })
  autoRemoveWatched: boolean;

  /** Keep the playlist's media downloaded on native iOS/Android clients. */
  @Column({ default: false })
  autoDownload: boolean;

  /**
   * User-picked cover. While null the client renders a 2×2 mosaic from the
   * first four items' posters. Reserved for a later "choose cover" feature.
   */
  @Column({ type: 'varchar', length: 512, nullable: true, default: null })
  coverImageUrl: string | null;

  @OneToMany(() => PlaylistItem, (item) => item.playlist, { cascade: true })
  items: PlaylistItem[];
}
