import { Controller, Delete, HttpCode, HttpStatus, Param, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { PluginInstallService } from './plugin-install.service';

@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginsController {
  constructor(private readonly installService: PluginInstallService) {}

  /** Row + registry entry + extracted directory. Safe on a plugin whose files or row are already gone. */
  @Delete(':pluginId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  @HttpCode(HttpStatus.NO_CONTENT)
  async uninstall(@Param('pluginId') pluginId: string): Promise<void> {
    await this.installService.uninstall(pluginId);
  }
}
