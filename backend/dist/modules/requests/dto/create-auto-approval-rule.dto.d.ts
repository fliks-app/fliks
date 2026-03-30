import type { AutoApprovalCondition } from '../entities/auto-approval-rule.entity';
declare class ConditionDto implements AutoApprovalCondition {
    field: AutoApprovalCondition['field'];
    operator: AutoApprovalCondition['operator'];
    value: string | number;
}
export declare class CreateAutoApprovalRuleDto {
    name: string;
    enabled?: boolean;
    conditions: ConditionDto[];
    priority?: number;
}
export {};
