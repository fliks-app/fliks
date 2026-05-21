import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

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

  /** Library that owns the destination. The file is copied/moved under
   *  its root folder, never registered in place. */
  @IsInt()
  @Min(1)
  targetLibraryId: number;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ConfirmDiskImportDto {
  /** Whether to copy each file into the library (leaving the source in
   *  place) or move it (deleting the source after a successful copy). */
  @IsIn(['copy', 'move'])
  method: 'copy' | 'move';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportFileEntry)
  imports: ImportFileEntry[];
}
