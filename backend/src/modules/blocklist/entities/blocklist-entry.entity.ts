import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('blocklist')
export class BlocklistEntry extends BaseEntity {
  @Column()
  sourceTitle: string;

  @Column({ nullable: true })
  indexerId: number;

  @Column({ nullable: true })
  indexerName: string;

  @Column({ nullable: true })
  downloadUrl: string;

  @Column({ nullable: true })
  quality: string;

  @Column({ nullable: true })
  mediaId: number;

  @Column({ nullable: true })
  note: string;
}
