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
import * as nodePath from 'path';
import { BaseEntity } from '../../../common/entities/base.entity';
import {
  MediaType,
  MediaStatus,
  MinimumAvailability,
} from '../../../common/enums';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { RootFolder } from '../../root-folders/entities/root-folder.entity';
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
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
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

  @ManyToOne(() => RootFolder, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'rootFolderId' })
  rootFolder: RootFolder | null;

  @RelationId((m: Media) => m.rootFolder)
  rootFolderId: number | null;

  /**
   * Library this media belongs to. Coexists with `rootFolderId`: the FK here
   * drives ACL filtering and stalled-cleanup lookups, the rootFolder FK drives
   * disk I/O. Invariant: `media.rootFolder.libraryId === media.libraryId`.
   *
   * `onDelete: RESTRICT` matches the service-level guard that forbids deleting
   * a library while it still owns media — the DB is the second line of defence.
   */
  @ManyToOne(() => Library, { nullable: true, onDelete: 'RESTRICT' })
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

  /** Virtual computed path: rootFolder.path + '/' + folderName */
  get path(): string | null {
    return this.rootFolder?.path && this.folderName
      ? nodePath.join(this.rootFolder.path, this.folderName)
      : null;
  }

  @Column({ nullable: true })
  posterUrl: string;

  /** Set when metadata was last successfully pulled from TMDB (manual or scheduled refresh). */
  @Column({ type: 'timestamptz', nullable: true })
  metadataRefreshedAt: Date | null;

  @Column({ nullable: true })
  fanartUrl: string;

  @Column({ type: 'float', nullable: true })
  rating: number;

  @Column({ type: 'jsonb', nullable: true })
  genres: string[];

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
