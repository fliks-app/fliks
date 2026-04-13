import {
  Entity,
  Column,
  OneToMany,
  ManyToOne,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType } from '../../../common/enums/media-type.enum';
import type { StalledCleanupProfileKey } from '../../../common/constants/stalled-cleanup-profiles';
import { RootFolder } from '../../root-folders/entities/root-folder.entity';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';

/**
 * User-facing top-level container for media.
 * Owns one or more root paths (internal) and carries the settings that used to
 * live on RootFolder: allowed media types, preferred metadata provider,
 * stalled-cleanup profile, and default quality/language profiles used when
 * adding new media to this library.
 *
 * Access is granted per-user through {@link LibraryUserAccess}.
 */
@Entity('libraries')
export class Library extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column({ type: 'jsonb', default: [MediaType.MOVIE, MediaType.SERIES] })
  mediaTypes: MediaType[];

  @Column({ type: 'varchar', nullable: true, default: null })
  preferredProvider: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  stalledCleanupProfile: StalledCleanupProfileKey | null;

  @ManyToOne(() => QualityProfile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'defaultQualityProfileId' })
  defaultQualityProfile: QualityProfile | null;

  @RelationId((lib: Library) => lib.defaultQualityProfile)
  defaultQualityProfileId: number | null;

  @ManyToOne(() => LanguageProfile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'defaultLanguageProfileId' })
  defaultLanguageProfile: LanguageProfile | null;

  @RelationId((lib: Library) => lib.defaultLanguageProfile)
  defaultLanguageProfileId: number | null;

  /** At most one library should carry this flag — enforced in service. */
  @Column({ default: false })
  isDefaultForMovies: boolean;

  /** At most one library should carry this flag — enforced in service. */
  @Column({ default: false })
  isDefaultForSeries: boolean;

  @OneToMany(() => RootFolder, (rf) => rf.library)
  rootFolders: RootFolder[];
}
