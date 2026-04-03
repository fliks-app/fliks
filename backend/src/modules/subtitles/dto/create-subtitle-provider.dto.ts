import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  IsArray,
  IsIn,
  Min,
} from 'class-validator';
import { SubtitleProviderType } from '../../../common/enums';

const PROVIDER_TYPES = Object.values(SubtitleProviderType);

export class CreateSubtitleProviderDto {
  @IsString()
  name: string;

  @IsIn(PROVIDER_TYPES)
  type: SubtitleProviderType;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsNumber()
  @Min(0)
  @IsOptional()
  priority?: number;

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  tagIds?: number[];
}
