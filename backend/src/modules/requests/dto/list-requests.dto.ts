import { IsEnum, IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { RequestStatus } from '../../../common/enums';

export class ListRequestsDto {
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
