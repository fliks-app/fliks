import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('quality_profiles')
export class QualityProfile extends BaseEntity {
  @Column()
  name: string;

  @Column()
  cutoff: number;

  @Column({ type: 'jsonb' })
  items: QualityProfileItem[];

  @Column({ default: false })
  upgradeAllowed: boolean;
}

export interface QualityProfileItem {
  quality: {
    id: number;
    name: string;
    resolution: number;
    source: string;
  };
  allowed: boolean;
  sortOrder: number;
  /** Items sharing the same non-null groupId are treated as equivalent rank. */
  groupId?: number;
}
