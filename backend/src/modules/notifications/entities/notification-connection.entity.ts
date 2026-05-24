import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export type NotificationType =
  | 'discord'
  | 'slack'
  | 'webhook'
  | 'gotify'
  | 'ntfy';

export type NotificationEvent =
  | 'request.created'
  | 'request.approved'
  | 'request.declined'
  | 'request.processing'
  | 'request.available'
  | 'grab.started'
  | 'download.complete'
  | 'health.issue'
  | 'subtitle.downloaded'
  | 'subtitle.upgraded'
  | 'subtitle.failed'
  | 'subtitle.synced';

@Entity('notification_connections')
export class NotificationConnection extends BaseEntity {
  @Column()
  name: string;

  @Column()
  type: NotificationType;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, unknown>;

  @Column({ type: 'jsonb', default: [] })
  events: NotificationEvent[];

  @Column({ default: true })
  enabled: boolean;
}
