import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class HistoryQueryDto {
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  mediaId?: number;
}
