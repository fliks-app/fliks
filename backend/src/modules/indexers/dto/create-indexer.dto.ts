import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  Min,
} from 'class-validator';

export class CreateIndexerDto {
  @IsString()
  name: string;

  /** Checked against the known implementations in `IndexersService.assertKnownImplementation`, not here. */
  @IsString()
  implementation: string;

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
