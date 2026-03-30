import { IsInt, IsString, IsOptional } from 'class-validator';

export class LinkTorrentDto {
  @IsInt()
  mediaId: number;

  @IsString()
  sourceTitle: string;

  @IsOptional()
  @IsInt()
  clientId?: number;
}
