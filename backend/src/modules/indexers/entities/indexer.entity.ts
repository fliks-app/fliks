import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Tag } from '../../tags/entities/tag.entity';

@Entity('indexers')
export class Indexer extends BaseEntity {
  @Column()
  name: string;

  @Column()
  implementation: string;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, unknown>;

  @Column({ default: true })
  enableRss: boolean;

  @Column({ default: true })
  enableSearch: boolean;

  @Column({ default: 25 })
  priority: number;

  @Column({ default: true })
  enabled: boolean;

  @ManyToMany(() => Tag, { eager: true })
  @JoinTable({ name: 'indexer_tags' })
  tags: Tag[];
}
