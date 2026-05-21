import { IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateRequestDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  qualityProfileId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  languageProfileId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  libraryId?: number;
}
