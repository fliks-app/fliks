import { Entity, Column, ManyToOne, OneToMany, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType, RequestStatus } from '../../../common/enums';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { RootFolder } from '../../root-folders/entities/root-folder.entity';
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

  @ManyToOne(() => RootFolder, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'rootFolderId' })
  rootFolder: RootFolder | null;

  @RelationId((r: FliksRequest) => r.rootFolder)
  rootFolderId: number | null;

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

  @OneToMany(() => RequestComment, (comment) => comment.request, {
    cascade: true,
  })
  comments: RequestComment[];
}
