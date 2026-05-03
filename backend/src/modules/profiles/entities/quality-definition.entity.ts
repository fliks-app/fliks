import { Entity, Column, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('quality_definitions')
@Unique(['qualityId'])
export class QualityDefinition extends BaseEntity {
  @Column()
  qualityId: number;

  @Column()
  title: string;

  /** Minimum size in MB per hour of content (0 = no limit). */
  @Column({ type: 'float', default: 0 })
  minSize: number;

  /** Preferred size in MB per hour of content. */
  @Column({ type: 'float', default: 0 })
  preferredSize: number;

  /** Maximum size in MB per hour of content (0 = no limit). */
  @Column({ type: 'float', default: 0 })
  maxSize: number;
}
