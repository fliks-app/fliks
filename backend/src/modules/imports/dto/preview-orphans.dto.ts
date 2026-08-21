import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { MediaType } from '../../../common/enums';

/** Orphan scan of a bare folder, before any library owns it. */
export class PreviewOrphansDto {
  @IsString()
  path: string;

  @IsOptional()
  @IsArray()
  @IsEnum(MediaType, { each: true })
  mediaTypes?: MediaType[];

  @IsOptional()
  @IsString()
  preferredProvider?: string | null;
}
