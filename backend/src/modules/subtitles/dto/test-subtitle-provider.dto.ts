import { IsIn, IsInt, IsObject, IsOptional } from 'class-validator';
import { SubtitleProviderType } from '../../../common/enums';

const PROVIDER_TYPES = Object.values(SubtitleProviderType);

export class TestSubtitleProviderDto {
  @IsIn(PROVIDER_TYPES)
  type: SubtitleProviderType;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;

  /** Set when testing a saved provider, so an untouched secret resolves. */
  @IsInt()
  @IsOptional()
  id?: number;
}
