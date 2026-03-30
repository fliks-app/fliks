import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Tag } from '../../tags/entities/tag.entity';

@Entity('download_clients')
export class DownloadClient extends BaseEntity {
  @Column()
  name: string;

  @Column()
  implementation: string;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, unknown>;

  @Column({ default: true })
  enabled: boolean;

  @Column({ default: 1 })
  priority: number;

  @ManyToMany(() => Tag, { eager: true })
  @JoinTable({ name: 'download_client_tags' })
  tags: Tag[];
}
