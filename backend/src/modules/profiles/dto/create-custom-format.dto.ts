import {
  IsString,
  IsNumber,
  IsArray,
  IsBoolean,
  IsOptional,
  ValidateNested,
  IsIn,
  ArrayNotEmpty,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CUSTOM_FORMAT_SPEC_TYPES,
  type CustomFormatSpecType,
} from '../entities/custom-format.entity';

class CustomFormatSpecDto {
  @IsIn(CUSTOM_FORMAT_SPEC_TYPES as readonly string[])
  type: CustomFormatSpecType;

  @IsString()
  @IsNotEmpty()
  value: string;

  @IsBoolean()
  @IsOptional()
  negate?: boolean;

  @IsBoolean()
  @IsOptional()
  required?: boolean;
}

export class CreateCustomFormatDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsOptional()
  score?: number;

  /** A format with no condition would match every release and apply its score
   *  to all of them, so an empty list is refused rather than saved. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CustomFormatSpecDto)
  specs: CustomFormatSpecDto[];
}
