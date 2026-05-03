import {
  IsString,
  IsBoolean,
  IsNumber,
  IsArray,
  IsOptional,
  ValidateNested,
  IsIn,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { AutoApprovalCondition } from '../entities/auto-approval-rule.entity';

class ConditionDto implements AutoApprovalCondition {
  @IsIn(['role', 'genre', 'year', 'seasons', 'userId'])
  field: AutoApprovalCondition['field'];

  @IsIn(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains'])
  operator: AutoApprovalCondition['operator'];

  value: string | number;
}

export class CreateAutoApprovalRuleDto {
  @IsString()
  name: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions: ConditionDto[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  priority?: number;
}
