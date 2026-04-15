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

  toJSON() {
    return { ...this, path: this.path };
  }
}
