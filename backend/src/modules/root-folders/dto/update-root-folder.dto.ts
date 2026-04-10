import { IsString, IsOptional, IsEnum, IsArray } from 'class-validator';
import { MediaType } from '../../../common/enums/media-type.enum';

export class UpdateRootFolderDto {
  @IsString()
  @IsOptional()
  path?: string;

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
}
