import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePlaylistDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsBoolean()
  autoRemoveWatched?: boolean;

  @IsOptional()
  @IsBoolean()
  autoDownload?: boolean;
}
