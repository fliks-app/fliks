import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('subtitle_blacklist')
export class SubtitleBlacklist extends BaseEntity {
  @Column()
  providerType: string;

  @Column()
  providerFileId: string;

  @Column({ nullable: true })
  mediaId: number;

  @Column({ nullable: true })
  language: string;

  @Column({ nullable: true })
  sourceTitle: string;

  @Column({ nullable: true })
  reason: string;
}
