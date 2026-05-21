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

const KNOWN_KEYS: ChecklistItemKey[] = [
  'library',
  'quality-profile',
  'language-profile',
  'download-client',
  'indexer',
  'subtitle-provider',
  'notification',
  'non-admin-user',
  'auto-approval-rule',
];

function parseKey(raw: string): ChecklistItemKey {
  if (!(KNOWN_KEYS as string[]).includes(raw)) {
    throw new BadRequestException(`Unknown checklist key: ${raw}`);
  }
  return raw as ChecklistItemKey;
}

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
    await this.service.dismiss(parseKey(key));
    return { ok: true };
  }

  @Delete(':key/dismiss')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async undismiss(@Param('key') key: string) {
    await this.service.undismiss(parseKey(key));
    return { ok: true };
  }
}
