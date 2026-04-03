import {
  IsArray,
  ValidateNested,
  IsNumber,
  IsString,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class QualityDefinitionItemDto {
  @IsNumber()
  qualityId: number;

  @IsString()
  @IsOptional()
  title?: string;

  @IsNumber()
  @Min(0)
  minSize: number;

  @IsNumber()
  @Min(0)
  preferredSize: number;

  @IsNumber()
  @Min(0)
  maxSize: number;
}

export class UpdateQualityDefinitionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QualityDefinitionItemDto)
  items: QualityDefinitionItemDto[];
}
