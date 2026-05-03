import { IsIn, IsObject } from 'class-validator';

export class TestDownloadClientDto {
  @IsIn(['qbittorrent'])
  implementation: string;

  @IsObject()
  settings: Record<string, unknown>;
}
