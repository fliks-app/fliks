import { IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdateMediaProfilesDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(1)
  qualityProfileId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @ValidateIf((o) => o.languageProfileId !== null)
  languageProfileId?: number | null;
}
