import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { PluginBackupService, PluginExportDocument, PluginImportResult } from './plugin-backup.service';

/** An export is a credential-bearing document — whatever the plugin stored, `secret` fields
 *  included — so both routes sit behind the same admin policy as the rest of `/plugins`. */
@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginBackupController {
  constructor(private readonly backup: PluginBackupService) {}

  @Get(':pluginId/export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async export(@Param('pluginId') pluginId: string): Promise<PluginExportDocument> {
    return this.backup.exportPlugin(pluginId);
  }

  @Post(':pluginId/import')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async import(@Param('pluginId') pluginId: string, @Body() document: unknown): Promise<PluginImportResult> {
    return this.backup.importPlugin(pluginId, document);
  }
}
