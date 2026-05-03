import { IsArray, IsInt } from 'class-validator';

export class AssignLibraryAccessDto {
  @IsArray()
  @IsInt({ each: true })
  userIds: number[];
}
