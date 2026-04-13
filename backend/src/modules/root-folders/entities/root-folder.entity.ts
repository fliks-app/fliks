import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType } from '../../../common/enums/media-type.enum';
import type { StalledCleanupProfileKey } from '../../../common/constants/stalled-cleanup-profiles';
import { Library } from '../../libraries/entities/library.entity';

@Entity('root_folders')
export class RootFolder extends BaseEntity {
  @Column({ unique: true })
  path: string;

  @Column({ nullable: true })
  label: string;

  /**
   * Library this root path belongs to. Nullable only for the transient window
   * between entity creation and the startup auto-wrap migration; after that,
   * every RootFolder has a library.
   */
  @ManyToOne(() => Library, (lib) => lib.rootFolders, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'libraryId' })
  library: Library | null;

  @RelationId((rf: RootFolder) => rf.library)
  libraryId: number | null;

  // ── Legacy columns — kept for data safety under `synchronize: true`.
  //    Business logic must read from `library.*` instead.

  /** @deprecated Read from `library.mediaTypes`. Kept as inert data. */
  @Column({ type: 'jsonb', default: [MediaType.MOVIE, MediaType.SERIES] })
  mediaTypes: MediaType[];

  /** @deprecated Read from `library.preferredProvider`. Kept as inert data. */
  @Column({ type: 'varchar', nullable: true, default: null })
  preferredProvider: string | null;

  /** @deprecated Read from `library.stalledCleanupProfile`. Kept as inert data. */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  stalledCleanupProfile: StalledCleanupProfileKey | null;
}
