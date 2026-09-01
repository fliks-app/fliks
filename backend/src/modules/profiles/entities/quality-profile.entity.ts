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

  /** When true, auto/manual upgrades only grab releases whose resolution
   *  exceeds the best on-disk file — skips same-resolution tier hops
   *  (e.g. WEBDL-1080p → Bluray-1080p). */
  @Column({ default: false })
  resolutionUpgradeOnly: boolean;

  /** Releases whose total custom-format score falls below this are rejected, not
   *  merely ranked last — the only way a negative-score format can block a grab
   *  instead of being taken when nothing better exists. */
  @Column({ type: 'int', default: 0 })
  minCustomFormatScore: number;
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
