import { IsDateString, IsOptional, IsEnum } from 'class-validator';
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
}
