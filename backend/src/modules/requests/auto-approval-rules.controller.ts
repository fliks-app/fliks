import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AutoApprovalRule } from './entities/auto-approval-rule.entity';
import { CreateAutoApprovalRuleDto } from './dto/create-auto-approval-rule.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { NotFoundException } from '@nestjs/common';

@Controller('auto-approval-rules')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class AutoApprovalRulesController {
  constructor(
    @InjectRepository(AutoApprovalRule)
    private readonly repo: Repository<AutoApprovalRule>,
  ) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateAutoApprovalRuleDto) {
    const row = this.repo.create({
      name: dto.name,
      enabled: dto.enabled ?? true,
      criteria: dto.criteria,
    });
    return this.repo.save(row);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const rule = await this.repo.findOne({ where: { id } });
    if (!rule) throw new NotFoundException(`Rule #${id} not found`);
    return rule;
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateAutoApprovalRuleDto,
  ) {
    const rule = await this.repo.findOne({ where: { id } });
    if (!rule) throw new NotFoundException(`Rule #${id} not found`);
    rule.name = dto.name;
    rule.enabled = dto.enabled ?? true;
    rule.criteria = dto.criteria;
    return this.repo.save(rule);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const rule = await this.repo.findOne({ where: { id } });
    if (!rule) throw new NotFoundException(`Rule #${id} not found`);
    await this.repo.remove(rule);
  }
}
