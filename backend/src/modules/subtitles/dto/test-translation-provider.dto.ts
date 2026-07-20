import { IsIn, IsObject, IsOptional } from 'class-validator';
import { TRANSLATION_ENGINES } from '../../../common/enums';
import type { TranslationEngine } from '../../../common/enums';

export class TestTranslationProviderDto {
  @IsIn(TRANSLATION_ENGINES as unknown as string[])
  engine: TranslationEngine;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}
