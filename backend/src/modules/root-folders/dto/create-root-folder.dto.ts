import { IsString, IsOptional, IsEnum, IsArray, IsIn } from 'class-validator';
import { MediaType } from '../../../common/enums/media-type.enum';
import {
  STALLED_CLEANUP_PROFILE_KEYS,
  StalledCleanupProfileKey,
} from '../../../common/constants/stalled-cleanup-profiles';

export class CreateRootFolderDto {
  @IsString()
  path: string;

  @IsString()
  @IsOptional()
  label?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(MediaType, { each: true })
  mediaTypes?: MediaType[];

  @IsOptional()
  @IsString()
  preferredProvider?: string | null;

  @IsOptional()
  @IsIn([...STALLED_CLEANUP_PROFILE_KEYS, null])
  stalledCleanupProfile?: StalledCleanupProfileKey | null;
}
