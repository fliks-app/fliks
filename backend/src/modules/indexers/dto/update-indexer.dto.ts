import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  Min,
} from 'class-validator';

export class UpdateIndexerDto {
  @IsString()
  @IsOptional()
  name?: string;

  /** `"torznab"` or a plugin-namespaced descriptor id — checked against the
   *  registry in `IndexersService.assertKnownImplementation`, not here. */
  @IsString()
  @IsOptional()
  implementation?: string;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  enableRss?: boolean;

  @IsBoolean()
  @IsOptional()
  enableSearch?: boolean;

  @IsNumber()
  @Min(0)
  @IsOptional()
  priority?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  requestDelay?: number;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
