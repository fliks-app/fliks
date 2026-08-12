import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginProcessService } from '../plugin-process.service';
import { forwardPluginCall } from './plugin-proxy.controller';
import { PluginLegacyAliasMatchGuard, PluginLegacyAliasPolicyGuard, RESOLVED_LEGACY_ALIAS_KEY, type PluginLegacyAliasRequest } from './plugin-legacy-alias.guard';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';

/** Answers a plugin's declared `legacyPaths` — URLs the frozen native clients still call.
 *  Mounted last in `plugins.module.ts`'s `controllers[]`, after every other controller in the
 *  app, so this `*splat` wildcard only ever sees a request nothing else already claimed. */
@Controller()
@UseGuards(PluginLegacyAliasMatchGuard, JwtOrApiKeyGuard, PluginLegacyAliasPolicyGuard)
export class PluginLegacyAliasController {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly processService: PluginProcessService,
  ) {}

  @All('*splat')
  async handle(@Req() req: PluginLegacyAliasRequest, @Res() res: Response): Promise<void> {
    const alias = req[RESOLVED_LEGACY_ALIAS_KEY]!;
    await forwardPluginCall(this.registry, this.processService, alias.pluginId, alias.targetPath, req, res);
  }
}
