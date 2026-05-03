import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('custom_formats')
export class CustomFormat extends BaseEntity {
  @Column()
  name: string;

  /** Points added to a release score when all required conditions match */
  @Column({ type: 'int', default: 0 })
  score: number;

  @Column({ type: 'jsonb', default: [] })
  specifications: CustomFormatSpecification[];
}

export interface CustomFormatSpecification {
  name: string;
  implementation: string;
  negate: boolean;
  required: boolean;
  value: string;
}
