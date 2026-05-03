import { IsString } from 'class-validator';

export class ScanFolderDto {
  @IsString()
  folderPath: string;
}
