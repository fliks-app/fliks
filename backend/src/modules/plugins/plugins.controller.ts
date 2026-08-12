import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { PluginInstallService, PluginSummary } from './plugin-install.service';

@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginsController {
  constructor(private readonly installService: PluginInstallService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async list(): Promise<PluginSummary[]> {
    return this.installService.listInstalled();
  }

  /** `process` only — flips `plugin_registrations.enabled` and starts or stops the process to match. */

  /** Clears a tripped circuit breaker and respawns. */
  @Post(':pluginId/restart')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  @HttpCode(HttpStatus.NO_CONTENT)
  async restart(@Param('pluginId') pluginId: string): Promise<void> {
    await this.installService.restart(pluginId);
  }

  /** Drops the live registration, leaving the package row, archive and schema untouched. Idempotent. */
  @Post(':pluginId/disable')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async disable(@Param('pluginId') pluginId: string): Promise<PluginSummary> {
    return this.installService.disable(pluginId);
  }

  /** Re-registers through the same path a boot load takes. Idempotent. */
  @Post(':pluginId/enable')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async enable(@Param('pluginId') pluginId: string): Promise<PluginSummary> {
    return this.installService.enable(pluginId);
  }

  /** Row + registry entry + extracted directory. Safe on a plugin whose files or row are already gone. */
  @Delete(':pluginId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  @HttpCode(HttpStatus.NO_CONTENT)
  async uninstall(@Param('pluginId') pluginId: string): Promise<void> {
    await this.installService.uninstall(pluginId);
  }
}
