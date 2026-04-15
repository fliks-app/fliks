import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsObject,
  IsIn,
  Min,
} from 'class-validator';

export class UpdateIndexerDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsIn(['torznab'])
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

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

}
