import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class QualityItemDto {
  @IsNumber()
  qualityId: number;

  @IsString()
  qualityName: string;

  @IsNumber()
  resolution: number;

  @IsString()
  source: string;

  @IsBoolean()
  allowed: boolean;

  @IsNumber()
  sortOrder: number;

  @IsNumber()
  @IsOptional()
  groupId?: number;
}

export class CreateQualityProfileDto {
  @IsString()
  name: string;

  @IsNumber()
  cutoff: number;

  @IsBoolean()
  @IsOptional()
  upgradeAllowed?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QualityItemDto)
  items: QualityItemDto[];
}
