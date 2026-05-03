import {
  IsString,
  IsBoolean,
  IsArray,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { MediaServerType } from '../../../common/enums';

export class CreateMediaServerDto {
  @IsString()
  name: string;

  @IsEnum(MediaServerType)
  type: MediaServerType;

  @IsString()
  url: string;

  @IsString()
  @IsOptional()
  apiKey?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  events?: string[];

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
