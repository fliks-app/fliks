import { IsObject, IsString } from 'class-validator';

export class TestIndexerConnectionDto {
  /** `"torznab"` (settings.baseUrl is used) or a registered descriptor id
   *  (its endpoint is used instead) — resolved in `IndexersService`. */
  @IsString()
  implementation: string;

  @IsObject()
  settings: Record<string, unknown>;
}
