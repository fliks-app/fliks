import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  IsIn,
  Min,
} from 'class-validator';

export class CreateDownloadClientDto {
  @IsString()
  name: string;

  @IsIn(['qbittorrent'])
  implementation: string;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsNumber()
  @Min(1)
  @IsOptional()
  priority?: number;
}
