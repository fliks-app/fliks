import {
  IsString,
  IsNotEmpty,
  IsBoolean,
  IsInt,
  IsArray,
  IsOptional,
  IsEnum,
  IsDefined,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MediaType } from '../../../common/enums';
import type { AutoApprovalCriteria } from '../entities/auto-approval-rule.entity';

export class AutoApprovalCriteriaDto implements AutoApprovalCriteria {
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  roleIds?: number[];

  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  libraryIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  genreIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  maxSeasons?: number;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2200)
  yearFrom?: number;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2200)
  yearTo?: number;
}

export class CreateAutoApprovalRuleDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsDefined()
  @ValidateNested()
  @Type(() => AutoApprovalCriteriaDto)
  criteria: AutoApprovalCriteriaDto;
}
