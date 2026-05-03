import { IsOptional, IsString } from 'class-validator';

export class GrabMovieDto {
  @IsOptional()
  @IsString()
  downloadUrl?: string;

  @IsOptional()
  @IsString()
  sourceTitle?: string;
}
