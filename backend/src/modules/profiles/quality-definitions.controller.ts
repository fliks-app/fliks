import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { QualityDefinitionsService } from './quality-definitions.service';
import { UpdateQualityDefinitionsDto } from './dto/update-quality-definitions.dto';

@Controller('quality-definitions')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class QualityDefinitionsController {
  constructor(private readonly service: QualityDefinitionsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.service.findAll();
  }

  @Put()
  @CheckPolicies((ability) => ability.can(Action.Update, 'Settings'))
  updateAll(@Body() dto: UpdateQualityDefinitionsDto) {
    return this.service.updateAll(dto.items);
  }
}
