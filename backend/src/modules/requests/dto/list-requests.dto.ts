import { IsEnum, IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { RequestStatus, RequestKind, MediaType } from '../../../common/enums';

export class ListRequestsDto {
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @IsEnum(RequestKind)
  kind?: RequestKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  // Narrows the list to one title. `mediaType` must accompany it: TMDB numbers
  // movies and series in separate namespaces, so an id alone can match both.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tmdbId?: number;

  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
