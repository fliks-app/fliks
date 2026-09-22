import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../../auth/casl/policies.guard';
import { CheckPolicies } from '../../auth/casl/check-policies.decorator';
import { Action } from '../../auth/casl/actions.enum';
import { LiveTvAccessService } from '../services/livetv-access.service';
import { SetRestrictedGroupsDto } from '../dto/set-restricted-groups.dto';
import { SetGroupAccessDto } from '../dto/set-group-access.dto';

/** Who may see which channel groups. Administrators only, by construction. */
@Controller('livetv/admin/access')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
@CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
export class LiveTvAccessController {
  constructor(private readonly access: LiveTvAccessService) {}

  /** `exempt` names groups an admin deliberately unrestricted after an
   *  automatic match: they carry no badge of their own once out of `groups`,
   *  so this is the only way a second admin can see one was ever restricted. */
  @Get('restricted-groups')
  async restrictedGroups() {
    const [groups, exempt] = await Promise.all([
      this.access.restrictedGroupsView(),
      this.access.exemptGroups(),
    ]);
    return { groups, exempt };
  }

  @Put('restricted-groups')
  setRestrictedGroups(@Body() dto: SetRestrictedGroupsDto) {
    return this.access.setRestrictedGroups(dto.groups);
  }

  /** Every user with their granted groups, for the overview table. Lives here
   *  rather than behind `GET /users` so the tab needs only its own permission. */
  @Get('users')
  listUserAccess() {
    return this.access.listUserAccess();
  }

  @Get('users/:userId')
  async grants(@Param('userId', ParseIntPipe) userId: number) {
    const rows = await this.access.grantsFor(userId);
    return rows.map((row) => row.groupName);
  }

  @Put('users/:userId')
  setGrants(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetGroupAccessDto,
  ) {
    return this.access.setGrants(userId, dto.groups);
  }
}
