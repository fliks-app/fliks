import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Tag } from '../../tags/entities/tag.entity';

@Entity('delay_profiles')
export class DelayProfile extends BaseEntity {
  /** Delay in hours before a torrent release is eligible for grab. */
  @Column({ type: 'int', default: 0 })
  torrentDelay: number;

  /** Lower = higher priority when multiple profiles match. */
  @Column({ default: 1 })
  order: number;

  @ManyToMany(() => Tag, { eager: true })
  @JoinTable({ name: 'delay_profile_tags' })
  tags: Tag[];
}
