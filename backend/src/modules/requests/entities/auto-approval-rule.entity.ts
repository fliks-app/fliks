import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('auto_approval_rules')
export class AutoApprovalRule extends BaseEntity {
  @Column()
  name: string;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb' })
  conditions: AutoApprovalCondition[];

  @Column({ default: 0 })
  priority: number;
}

export interface AutoApprovalCondition {
  field: 'role' | 'genre' | 'year' | 'seasons' | 'userId';
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains';
  value: string | number;
}
