import {
  IsString,
  IsBoolean,
  IsArray,
  IsOptional,
  IsObject,
  IsIn,
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

export class CreateNotificationConnectionDto {
  @IsString()
  name: string;

  @IsIn(VALID_TYPES)
  type: string;

  @IsObject()
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
