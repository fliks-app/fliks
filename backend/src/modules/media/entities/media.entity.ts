import {
  Entity,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  JoinColumn,
  RelationId,
  Index,
} from 'typeorm';
import { Expose } from 'class-transformer';
import * as nodePath from 'path';
import { BaseEntity } from '../../../common/entities/base.entity';
import {
  MediaType,
  MediaStatus,
  MinimumAvailability,
} from '../../../common/enums';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { Library } from '../../libraries/entities/library.entity';
import { User } from '../../users/entities/user.entity';
import { Season } from './season.entity';
import { MediaFile } from './media-file.entity';
import { MediaMetadata } from './media-metadata.entity';
import { MediaCast } from './media-cast.entity';
import { MediaCrew } from './media-crew.entity';

@Entity('media')
@Index('idx_media_search_vector', { synchronize: false })
@Index('UQ_media_type_tmdbId', ['type', 'tmdbId'], { unique: true })
@Index('IDX_media_addedById', ['addedBy'])
export class Media extends BaseEntity {
  @Column()
  title: string;

  @Column({ nullable: true })
  originalTitle: string;

  /**
   * International release titles (TMDB `alternative_titles`, TVDB
   * `aliases`). Used to validate Torznab results: a release labelled with
   * a localised name — e.g. "A Very Secret Service" for "Au service de la
   * France" — still matches if the localised form is in this list.
   * Empty array when the provider returns no aliases.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  alternativeTitles: string[];

  @Column({ nullable: true })
  year: number;

  @Column({ type: 'enum', enum: MediaType })
  type: MediaType;

  @Column({ type: 'int', nullable: true })
  tmdbId: number;

  @Column({ nullable: true })
  imdbId: string;

  @Column({ type: 'int', nullable: true })
  tvdbId: number;

  @Column({ type: 'text', nullable: true })
  overview: string;

  @Column({ type: 'enum', enum: MediaStatus, default: MediaStatus.TBA })
  status: MediaStatus;

  @Column({ default: true })
  monitored: boolean;

  /**
   * Library this media lives in. Both ACL filtering and disk I/O resolve
   * through here — the library carries `path`, the media stores
   * `folderName`, and `media.path` derives from both (see getter below).
   *
   * `onDelete: RESTRICT` matches the service-level guard that forbids
   * deleting a library while it still owns media — the DB is the second
   * line of defence.
   * `eager: true` because the `path` getter needs the library on every
   * read.
   */
  @ManyToOne(() => Library, {
    nullable: true,
    eager: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'libraryId' })
  library: Library | null;

  @RelationId((m: Media) => m.library)
  libraryId: number | null;

  /**
   * Override of the library's metadata provider for this media. When set,
   * takes precedence over Library.preferredProvider. `null` → inherit.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  preferredProvider: string | null;

  @Column({ nullable: true })
  folderName: string;

  /** Virtual computed path: library.path + '/' + folderName */
  @Expose()
  get path(): string | null {
    return this.library?.path && this.folderName
      ? nodePath.join(this.library.path, this.folderName)
      : null;
  }

  @Column({ nullable: true })
  posterUrl: string;

  /** Set when metadata was last successfully pulled from TMDB (manual or scheduled refresh). */
  @Column({ type: 'timestamptz', nullable: true })
  metadataRefreshedAt: Date | null;

  @Column({ nullable: true })
  fanartUrl: string;

  /** Transparent PNG "clearlogo" (title treatment), stored as a local API
   *  path. Null when the provider has no logo for the title. */
  @Column({ nullable: true })
  logoUrl: string;

  /** Extra fanarts pulled from the provider (top N by score), stored
   *  as local API paths (variants `fanart-1`, `fanart-2`, …). Mixed
   *  with {@link fanartUrl} to randomise the page background. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  additionalFanartUrls: string[];

  @Column({ type: 'float', nullable: true })
  rating: number;

  @Column({ type: 'jsonb', nullable: true })
  genres: string[];

  @Column({ type: 'integer', nullable: true })
  tmdbCollectionId: number | null;

  @Column({ type: 'varchar', nullable: true })
  tmdbCollectionName: string | null;

  @Column({ nullable: true })
  runtime: number;

  @Column({ type: 'date', nullable: true })
  releaseDate: string;

  @Column({ type: 'date', nullable: true })
  inCinemas: string;

  @Column({ type: 'date', nullable: true })
  digitalRelease: string;

  @Column({ type: 'date', nullable: true })
  physicalRelease: string;

  @Column({ type: 'varchar', default: MinimumAvailability.RELEASED })
  minimumAvailability: MinimumAvailability;

  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
  })
  searchVector: string;

  @ManyToOne(() => QualityProfile, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'qualityProfileId' })
  qualityProfile: QualityProfile | null;

  @RelationId((m: Media) => m.qualityProfile)
  qualityProfileId: number | null;

  @ManyToOne(() => LanguageProfile, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'languageProfileId' })
  languageProfile: LanguageProfile | null;

  @RelationId((m: Media) => m.languageProfile)
  languageProfileId: number | null;

  @OneToOne(() => MediaMetadata, (mm) => mm.media, {
    cascade: true,
    eager: true,
  })
  metadata: MediaMetadata;

  @OneToMany(() => MediaCast, (mc) => mc.media, { cascade: true })
  cast: MediaCast[];

  @OneToMany(() => MediaCrew, (mc) => mc.media, { cascade: true })
  crew: MediaCrew[];

  @OneToMany(() => Season, (season) => season.media, { cascade: true })
  seasons: Season[];

  @OneToMany(() => MediaFile, (file) => file.media, { cascade: true })
  files: MediaFile[];

  /**
   * User who initiated the direct import (no Request involved). Null for media
   * created via approved Requests, disk rescans, or arr migrations — those
   * flows attribute ownership elsewhere (Request.user, etc.).
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'addedById' })
  addedBy: User | null;

  @RelationId((m: Media) => m.addedBy)
  addedById: number | null;

  toJSON() {
    return { ...this, path: this.path };
  }
}
