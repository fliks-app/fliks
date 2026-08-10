import { IsObject, IsString } from 'class-validator';

export class TestIndexerConnectionDto {
  /** `"torznab"` is the only value core resolves — settings.baseUrl is used. */
  @IsString()
  implementation: string;

  @IsObject()
  settings: Record<string, unknown>;
}
