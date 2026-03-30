import { IsString, IsOptional, IsNumber } from 'class-validator';

export class CreateBlocklistEntryDto {
  @IsString()
  sourceTitle: string;

  @IsNumber()
  @IsOptional()
  indexerId?: number;

  @IsString()
  @IsOptional()
  indexerName?: string;

  @IsString()
  @IsOptional()
  downloadUrl?: string;

  @IsString()
  @IsOptional()
  quality?: string;

  @IsNumber()
  @IsOptional()
  mediaId?: number;

  @IsString()
  @IsOptional()
  note?: string;
}
