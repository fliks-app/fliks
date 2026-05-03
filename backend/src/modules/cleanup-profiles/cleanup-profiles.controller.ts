import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { CleanupProfilesService } from './cleanup-profiles.service';
import { UpdateCleanupProfileDto } from './dto/update-cleanup-profile.dto';
import {
  STALLED_CLEANUP_PROFILE_KEYS,
  StalledCleanupProfileKey,
} from '../../common/constants/stalled-cleanup-profiles';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

@Controller('cleanup-profiles')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class CleanupProfilesController {
  constructor(private readonly service: CleanupProfilesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.service.findAll();
  }

  @Patch(':key')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(@Param('key') key: string, @Body() dto: UpdateCleanupProfileDto) {
    if (
      !STALLED_CLEANUP_PROFILE_KEYS.includes(key as StalledCleanupProfileKey)
    ) {
      throw new BadRequestException(
        `Unknown profile "${key}". Expected one of: ${STALLED_CLEANUP_PROFILE_KEYS.join(', ')}`,
      );
    }
    return this.service.update(key as StalledCleanupProfileKey, dto);
  }
}
