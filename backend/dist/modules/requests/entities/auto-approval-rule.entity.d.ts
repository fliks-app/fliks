import { BaseEntity } from '../../../common/entities/base.entity';
export declare class AutoApprovalRule extends BaseEntity {
    name: string;
    enabled: boolean;
    conditions: AutoApprovalCondition[];
    priority: number;
}
export interface AutoApprovalCondition {
    field: 'role' | 'genre' | 'year' | 'seasons' | 'userId';
    operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains';
    value: string | number;
}
