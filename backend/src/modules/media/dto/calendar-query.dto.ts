import { IsDateString, IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { MediaType } from '../../../common/enums';

export class CalendarQueryDto {
  @IsDateString()
  @IsOptional()
  start?: string;

  @IsDateString()
  @IsOptional()
  end?: string;

  @IsEnum(MediaType)
  @IsOptional()
  type?: MediaType;

  /** When true, only return monitored media/episodes. */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  monitoredOnly?: boolean;
}
