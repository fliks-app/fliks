import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class SetRestrictedGroupsDto {
  /** Group names that need an explicit grant to be visible. */
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  groups: string[];
}
