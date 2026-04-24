import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class PatchSeasonDto {
  @IsOptional()
  @IsBoolean()
  monitored?: boolean;

  @IsOptional()
  @IsIn(['tmdb', 'tvdb', null])
  preferredProvider?: 'tmdb' | 'tvdb' | null;
}
