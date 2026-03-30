import { Repository } from 'typeorm';
import { AutoApprovalRule } from './entities/auto-approval-rule.entity';
import { CreateAutoApprovalRuleDto } from './dto/create-auto-approval-rule.dto';
export declare class AutoApprovalRulesController {
    private readonly repo;
    constructor(repo: Repository<AutoApprovalRule>);
    create(dto: CreateAutoApprovalRuleDto): Promise<AutoApprovalRule>;
    findAll(): Promise<AutoApprovalRule[]>;
    findOne(id: number): Promise<AutoApprovalRule>;
    update(id: number, dto: CreateAutoApprovalRuleDto): Promise<AutoApprovalRule>;
    remove(id: number): Promise<void>;
}
