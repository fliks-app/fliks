import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinTable,
  JoinColumn,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import {
  MediaType,
  MediaStatus,
  MinimumAvailability,
} from '../../../common/enums';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { Tag } from '../../tags/entities/tag.entity';
import { Season } from './season.entity';
import { MediaFile } from './media-file.entity';

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

  @Column({ type: 'text', nullable: true })
  overview: string;

  @Column({ type: 'enum', enum: MediaStatus, default: MediaStatus.TBA })
  status: MediaStatus;

  @Column({ default: true })
  monitored: boolean;

  @Column({ nullable: true })
  path: string;

  @Column({ nullable: true })
  folderName: string;

  @Column({ nullable: true })
  posterUrl: string;

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

  @ManyToOne(() => QualityProfile, { nullable: true, eager: true })
  @JoinColumn({ name: 'qualityProfileId' })
  qualityProfile: QualityProfile;

  @Column({ nullable: true })
  qualityProfileId: number;

  @ManyToOne(() => LanguageProfile, { nullable: true, eager: true })
  @JoinColumn({ name: 'languageProfileId' })
  languageProfile: LanguageProfile;

  @Column({ nullable: true })
  languageProfileId: number;

  @ManyToMany(() => Tag, { eager: true })
  @JoinTable({ name: 'media_tags' })
  tags: Tag[];

  @OneToMany(() => Season, (season) => season.media, { cascade: true })
  seasons: Season[];

  @OneToMany(() => MediaFile, (file) => file.media, { cascade: true })
  files: MediaFile[];
}
