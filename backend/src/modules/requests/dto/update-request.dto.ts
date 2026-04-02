import { IsInt, IsOptional, IsString } from 'class-validator';
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
  @IsString()
  rootFolder?: string;
}
