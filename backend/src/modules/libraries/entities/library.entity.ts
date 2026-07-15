import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType } from '../../../common/enums/media-type.enum';
import type { StalledCleanupProfileKey } from '../../../common/constants/stalled-cleanup-profiles';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';

/**
 * User-facing top-level container for media. Owns a single filesystem
 * path (`path`) where Fliks drops files for this library.
 *
 * Access is granted per-user through {@link LibraryUserAccess}.
 */
@Entity('libraries')
export class Library extends BaseEntity {
  @Column({ unique: true })
  name: string;

  /** Lucide icon name (e.g. 'film', 'tv', 'book', 'gamepad-2'). */
  @Column({ type: 'varchar', length: 48, nullable: true, default: null })
  icon: string | null;

  /** CSS color used on the home page card (e.g. 'primary', 'secondary', '#e74c3c'). */
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  color: string | null;

  @Column({ type: 'jsonb', default: [MediaType.MOVIE, MediaType.SERIES] })
  mediaTypes: MediaType[];

  @Column({ type: 'varchar', nullable: true, default: null })
  preferredProvider: string | null;

  /** Overrides the global metadata language for this library's media (null =
   *  inherit the global setting). ISO 639-1 code. */
  @Column({ type: 'varchar', length: 8, nullable: true, default: null })
  metadataLanguage: string | null;

  /** Overrides the global metadata region for this library's media (null =
   *  inherit the global setting). ISO 3166-1 code. */
  @Column({ type: 'varchar', length: 8, nullable: true, default: null })
  metadataRegion: string | null;

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

  /** Absolute path on the server where Fliks drops media in this library. */
  @Column({ type: 'varchar', nullable: true, default: null })
  path: string | null;

  /** Free-form admin annotation. */
  @Column({ type: 'varchar', nullable: true, default: null })
  label: string | null;
}
