import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class SetGroupAccessDto {
  /** The restricted groups this user is granted. Replaces the whole set. */
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  groups: string[];
}
