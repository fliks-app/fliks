import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { SchedulerService } from './scheduler.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

class TriggerCommandDto {
  @IsString()
  name: string;
}

@Controller('commands')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class CommandsController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  list() {
    return this.scheduler.getRecentCommands();
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  trigger(@Body() dto: TriggerCommandDto) {
    return this.scheduler.triggerCommand(dto.name);
  }
}
