import { IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { TRANSLATION_ENGINES } from '../../../common/enums';
import type { TranslationEngine } from '../../../common/enums';

export class UpdateTranslationProviderDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsIn(TRANSLATION_ENGINES as unknown as string[])
  @IsOptional()
  engine?: TranslationEngine;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
