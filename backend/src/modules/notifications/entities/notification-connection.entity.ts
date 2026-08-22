import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export const NOTIFICATION_TYPES = ['discord', 'slack', 'webhook', 'gotify', 'ntfy'] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Where each sender reads its endpoint from: Discord and Slack address a webhook, the rest a
 *  server. Read by the sender and by the DTO that validates it, so there is one map, not two. */
export const ENDPOINT_KEY: Record<NotificationType, 'webhookUrl' | 'url'> = {
  discord: 'webhookUrl',
  slack: 'webhookUrl',
  webhook: 'url',
  gotify: 'url',
  ntfy: 'url',
};

/** The one event vocabulary: the DTO validates against it and the editor lists what the API
 *  advertises from it, so an event added here needs no second or third copy. */
export const NOTIFICATION_EVENTS = [
  'request.created',
  'request.approved',
  'request.declined',
  'request.processing',
  'request.available',
  'request.delete.created',
  'request.delete.approved',
  'request.delete.declined',
  'grab.started',
  'download.complete',
  'health.issue',
  'subtitle.downloaded',
  'subtitle.upgraded',
  'subtitle.failed',
  'subtitle.synced',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

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
