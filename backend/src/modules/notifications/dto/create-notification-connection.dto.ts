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
import {
  ENDPOINT_KEY,
  NOTIFICATION_EVENTS,
  NOTIFICATION_TYPES,
  NotificationType,
} from '../entities/notification-connection.entity';

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

@ValidatorConstraint({ name: 'notificationSettings' })
class NotificationSettingsConstraint implements ValidatorConstraintInterface {
  validate(settings: unknown, args: ValidationArguments): boolean {
    const { type } = args.object as CreateNotificationConnectionDto;
    const key = ENDPOINT_KEY[type as NotificationType];
    if (!key) return true; // unknown type: @IsIn already rejected it
    const s = (settings ?? {}) as Record<string, unknown>;
    // Either key is accepted: the service folds `webhookUrl` onto `url` for the
    // types whose sender reads `url`.
    const endpoint = key === 'url' ? s.url || s.webhookUrl : s.webhookUrl;
    return /^https?:\/\//i.test(asText(endpoint));
  }

  defaultMessage(args: ValidationArguments): string {
    const { type } = args.object as CreateNotificationConnectionDto;
    return `${type} requires settings.${ENDPOINT_KEY[type as NotificationType] ?? 'url'} to be an http(s) URL`;
  }
}

export class CreateNotificationConnectionDto {
  @IsString()
  name: string;

  @IsIn(NOTIFICATION_TYPES)
  type: string;

  @IsObject()
  @Validate(NotificationSettingsConstraint)
  settings: Record<string, unknown>;

  @IsArray()
  @IsIn(NOTIFICATION_EVENTS, { each: true })
  @IsOptional()
  events?: string[];

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
