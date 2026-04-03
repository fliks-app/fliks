import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';

@Entity('download_history')
export class DownloadHistory extends BaseEntity {
  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  media: Media;

  @Column()
  mediaId: number;

  @Column({ nullable: true })
  indexerId: number;

  @Column({ nullable: true })
  downloadClientId: number;

  @Column()
  sourceTitle: string;

  @Column()
  quality: string;

  @Column({ nullable: true })
  language: string;

  @Column({ nullable: true })
  torrentHash: string;

  @Column({ default: 'grabbed' })
  status: string;

  @Column({ type: 'text', nullable: true })
  statusMessage: string;
}
