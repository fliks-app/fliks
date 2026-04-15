import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  IsIn,
  Min,
} from 'class-validator';
import { SubtitleProviderType } from '../../../common/enums';

const PROVIDER_TYPES = Object.values(SubtitleProviderType);

export class UpdateSubtitleProviderDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsIn(PROVIDER_TYPES)
  @IsOptional()
  type?: SubtitleProviderType;

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

}
