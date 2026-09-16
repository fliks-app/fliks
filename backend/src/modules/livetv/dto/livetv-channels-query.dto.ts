import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class LiveTvChannelsQueryDto {
  @IsOptional()
  @IsString()
  group?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  favoritesOnly?: boolean;

  @IsOptional()
  @IsString()
  query?: string;
}
