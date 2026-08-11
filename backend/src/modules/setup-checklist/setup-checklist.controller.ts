import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import {
  ChecklistItemKey,
  SetupChecklistService,
} from './setup-checklist.service';

@Controller('setup-checklist')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SetupChecklistController {
  constructor(private readonly service: SetupChecklistService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  list() {
    return this.service.getStatus();
  }

  @Post(':key/dismiss')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async dismiss(@Param('key') key: string) {
    await this.service.dismiss(this.parseKey(key));
    return { ok: true };
  }

  @Delete(':key/dismiss')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async undismiss(@Param('key') key: string) {
    await this.service.undismiss(this.parseKey(key));
    return { ok: true };
  }

  /** Validates against the merged core + bundle key set the service knows
   *  about, rather than a list hardcoded here. */
  private parseKey(raw: string): ChecklistItemKey {
    if (!this.service.isKnownKey(raw)) {
      throw new BadRequestException(`Unknown checklist key: ${raw}`);
    }
    return raw;
  }
}
