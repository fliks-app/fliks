import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Indexer } from '../../indexers/entities/indexer.entity';
import { Media } from '../../media/entities/media.entity';
import { User } from '../../users/entities/user.entity';

@Entity('blocklist')
export class BlocklistEntry extends BaseEntity {
  @Column()
  sourceTitle: string;

  @ManyToOne(() => Indexer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'indexerId' })
  indexer: Indexer | null;

  @RelationId((b: BlocklistEntry) => b.indexer)
  indexerId: number;

  @Column({ nullable: true })
  indexerName: string;

  @Column({ nullable: true })
  downloadUrl: string;

  @Column({ nullable: true })
  quality: string;

  @ManyToOne(() => Media, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'mediaId' })
  media: Media | null;

  @RelationId((b: BlocklistEntry) => b.media)
  mediaId: number;

  @Column({ nullable: true })
  note: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  @RelationId((b: BlocklistEntry) => b.user)
  userId: number | null;
}
