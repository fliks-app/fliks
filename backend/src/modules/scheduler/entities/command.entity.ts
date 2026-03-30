import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('commands')
export class Command extends BaseEntity {
  @Column()
  name: string;

  @Column({ default: 'queued' })
  status: string;

  @Column({ type: 'timestamptz', nullable: true })
  startedOn: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedOn: Date;

  @Column({ default: 'manual' })
  trigger: string;

  @Column({ type: 'jsonb', nullable: true })
  body: Record<string, unknown>;
}
