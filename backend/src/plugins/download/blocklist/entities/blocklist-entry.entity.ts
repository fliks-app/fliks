import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../../common/entities/base.entity';
import { Media } from '../../../../modules/media/entities/media.entity';
import { User } from '../../../../modules/users/entities/user.entity';

@Entity('blocklist')
@Index('UQ_blocklist_sourceTitle_lower', { synchronize: false })
export class BlocklistEntry extends BaseEntity {
  @Column()
  sourceTitle: string;

  /** Not a relation: `indexers` becomes a plugin-owned table, and core may not
   *  hold a foreign key into it. `indexerName` is what the UI renders. */
  @Column({ type: 'int', nullable: true })
  indexerId: number | null;

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
