import {
  IsString,
  IsBoolean,
  IsArray,
  IsOptional,
  IsObject,
  IsIn,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const VALID_TYPES = ['discord', 'slack', 'webhook', 'gotify', 'ntfy'];
const VALID_EVENTS = [
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
];

/** Where each sender reads its endpoint from. Discord and Slack address a
 *  webhook; the rest address a server. Kept in step with `NotificationsService.send`. */
const ENDPOINT_KEY: Record<string, 'webhookUrl' | 'url'> = {
  discord: 'webhookUrl',
  slack: 'webhookUrl',
  webhook: 'url',
  gotify: 'url',
  ntfy: 'url',
};

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

@ValidatorConstraint({ name: 'notificationSettings' })
class NotificationSettingsConstraint implements ValidatorConstraintInterface {
  validate(settings: unknown, args: ValidationArguments): boolean {
    const { type } = args.object as CreateNotificationConnectionDto;
    const key = ENDPOINT_KEY[type];
    if (!key) return true; // unknown type: @IsIn already rejected it
    const s = (settings ?? {}) as Record<string, unknown>;
    // `webhookUrl` stays accepted on the url-keyed types — older clients send
    // it, and the service folds it onto `url` before the row is saved.
    const endpoint = key === 'url' ? (s.url ?? s.webhookUrl) : s.webhookUrl;
    if (!asText(endpoint)) return false;
    return type !== 'gotify' || Boolean(asText(s.token));
  }

  defaultMessage(args: ValidationArguments): string {
    const { type } = args.object as CreateNotificationConnectionDto;
    if (type === 'gotify')
      return 'gotify requires a non-empty settings.url and settings.token';
    return `${type} requires a non-empty settings.${ENDPOINT_KEY[type] ?? 'url'}`;
  }
}

export class CreateNotificationConnectionDto {
  @IsString()
  name: string;

  @IsIn(VALID_TYPES)
  type: string;

  @IsObject()
  @Validate(NotificationSettingsConstraint)
  @IsOptional()
  settings?: Record<string, unknown>;

  @IsArray()
  @IsIn(VALID_EVENTS, { each: true })
  @IsOptional()
  events?: string[];

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
