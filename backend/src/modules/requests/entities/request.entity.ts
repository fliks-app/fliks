import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType, RequestStatus } from '../../../common/enums';
import { User } from '../../users/entities/user.entity';
import { RequestComment } from './request-comment.entity';

@Entity('requests')
export class FliksRequest extends BaseEntity {
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
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

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'approvedById' })
  approvedBy: User;

  @Column({ type: 'int', nullable: true })
  approvedById: number | null;

  @Column({ type: 'text', nullable: true })
  declinedReason: string | null;

  @Column({ type: 'int', nullable: true })
  qualityProfileId: number | null;

  @Column({ type: 'int', nullable: true })
  languageProfileId: number | null;

  @Column({ type: 'int', nullable: true })
  rootFolderId: number | null;

  /** ID of the imported media in the library (set on approval). */
  @Column({ type: 'int', nullable: true })
  mediaId: number | null;

  @Column({ type: 'jsonb', nullable: true })
  seasons: number[] | null;

  @OneToMany(() => RequestComment, (comment) => comment.request, {
    cascade: true,
  })
  comments: RequestComment[];
}
