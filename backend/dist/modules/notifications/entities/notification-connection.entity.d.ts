import { BaseEntity } from '../../../common/entities/base.entity';
export type NotificationType = 'discord' | 'slack' | 'webhook' | 'gotify' | 'ntfy';
export type NotificationEvent = 'request.created' | 'request.approved' | 'request.declined' | 'grab.started' | 'download.complete' | 'health.issue';
export declare class NotificationConnection extends BaseEntity {
    name: string;
    type: NotificationType;
    settings: Record<string, unknown>;
    events: NotificationEvent[];
    enabled: boolean;
}
