import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  RelationId,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType, RequestStatus, RequestKind } from '../../../common/enums';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { Library } from '../../libraries/entities/library.entity';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { RequestComment } from './request-comment.entity';

@Entity('requests')
export class FliksRequest extends BaseEntity {
  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @RelationId((r: FliksRequest) => r.user)
  userId: number;

  @Column({ type: 'enum', enum: MediaType })
  mediaType: MediaType;

  /** Whether the request asks to add the title to a library or to delete an
   *  existing library title. Delete requests target the whole title and
   *  resolve to APPROVED once the media is removed. */
  @Column({
    type: 'enum',
    enum: RequestKind,
    default: RequestKind.ADD,
  })
  kind: RequestKind;

  @Column()
  tmdbId: number;

  @Column()
  title: string;

  @Column({
    type: 'enum',
    enum: RequestStatus,
    default: RequestStatus.PENDING,
  })
  status: RequestStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'approvedById' })
  approvedBy: User | null;

  @RelationId((r: FliksRequest) => r.approvedBy)
  approvedById: number | null;

  @Column({ type: 'text', nullable: true })
  declinedReason: string | null;

  @ManyToOne(() => QualityProfile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'qualityProfileId' })
  qualityProfile: QualityProfile | null;

  @RelationId((r: FliksRequest) => r.qualityProfile)
  qualityProfileId: number | null;

  @ManyToOne(() => LanguageProfile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'languageProfileId' })
  languageProfile: LanguageProfile | null;

  @RelationId((r: FliksRequest) => r.languageProfile)
  languageProfileId: number | null;

  @ManyToOne(() => Library, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'libraryId' })
  library: Library | null;

  @RelationId((r: FliksRequest) => r.library)
  libraryId: number | null;

  /** ID of the imported media in the library (set on approval). */
  @ManyToOne(() => Media, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'mediaId' })
  media: Media | null;

  @RelationId((r: FliksRequest) => r.media)
  mediaId: number | null;

  @Column({ type: 'jsonb', nullable: true })
  seasons: number[] | null;

  /**
   * Local card art (`/api/images/request/{mediaType}-{tmdbId}/...`), stored
   * at creation so cards render from the cached image pipeline without a
   * metadata round-trip. Null when the download failed or the request
   * predates local request art — the client falls back to the metadata
   * lookup.
   */
  @Column({ type: 'text', nullable: true })
  posterUrl: string | null;

  @Column({ type: 'text', nullable: true })
  fanartUrl: string | null;

  @OneToMany(() => RequestComment, (comment) => comment.request, {
    cascade: true,
  })
  comments: RequestComment[];
}
