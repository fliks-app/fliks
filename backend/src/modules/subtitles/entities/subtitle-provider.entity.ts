import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { SubtitleProviderType } from '../../../common/enums';
import { Tag } from '../../tags/entities/tag.entity';

@Entity('subtitle_providers')
export class SubtitleProvider extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'enum', enum: SubtitleProviderType })
  type: SubtitleProviderType;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, unknown>;

  @Column({ default: 25 })
  priority: number;

  @ManyToMany(() => Tag, { eager: true })
  @JoinTable({ name: 'subtitle_provider_tags' })
  tags: Tag[];
}
