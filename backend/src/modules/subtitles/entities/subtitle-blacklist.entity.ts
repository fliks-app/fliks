import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from '../../media/entities/media.entity';

@Entity('subtitle_blacklist')
export class SubtitleBlacklist extends BaseEntity {
  @Column()
  providerType: string;

  @Column()
  providerFileId: string;

  @ManyToOne(() => Media, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'mediaId' })
  media: Media | null;

  @RelationId((sb: SubtitleBlacklist) => sb.media)
  mediaId: number;

  @Column({ nullable: true })
  language: string;

  @Column({ nullable: true })
  sourceTitle: string;

  @Column({ nullable: true })
  reason: string;
}
