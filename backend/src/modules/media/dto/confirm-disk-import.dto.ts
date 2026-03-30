import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

export class ImportFileEntry {
  @IsString()
  filePath: string;

  @IsInt()
  mediaId: number;

  @IsOptional()
  @IsInt()
  episodeId?: number;

  @IsString()
  quality: string;
}

export class ConfirmDiskImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportFileEntry)
  imports: ImportFileEntry[];
}
