import { IsInt } from 'class-validator';

export class UpdateRootFolderDto {
  @IsInt()
  rootFolderId: number;
}
