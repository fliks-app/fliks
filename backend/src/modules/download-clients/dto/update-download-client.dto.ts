import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  IsArray,
  IsIn,
  Min,
} from 'class-validator';

export class UpdateDownloadClientDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsIn(['qbittorrent'])
  @IsOptional()
  implementation?: string;

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

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  tagIds?: number[];
}
