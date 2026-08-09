import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { PluginRegistryService } from './plugin-registry.service';
import { readVerifiedLogo } from './archive';

/** Admin-UI-only image; unknown/unregistered ids 404 rather than probing the archive. */
@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginLogoController {
  constructor(private readonly registry: PluginRegistryService) {}

  @Get(':pluginId/logo')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async logo(@Param('pluginId') pluginId: string, @Res() res: Response): Promise<void> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) throw new NotFoundException();

    const logo = await readVerifiedLogo(plugin.archive);
    if (!logo) throw new NotFoundException();

    res.set({
      'Content-Type': logo.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    res.send(logo.content);
  }
}
