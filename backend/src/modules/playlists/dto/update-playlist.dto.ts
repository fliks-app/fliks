import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePlaylistDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsBoolean()
  autoRemoveWatched?: boolean;

  @IsOptional()
  @IsBoolean()
  autoDownload?: boolean;
}
