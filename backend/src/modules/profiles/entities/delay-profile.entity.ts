import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('delay_profiles')
export class DelayProfile extends BaseEntity {
  /** Delay in hours before a torrent release is eligible for grab. */
  @Column({ type: 'int', default: 0 })
  torrentDelay: number;

  /** Lower = higher priority when multiple profiles match. */
  @Column({ default: 1 })
  order: number;

}
