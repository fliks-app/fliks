import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PluginRegistryService } from './plugin-registry.service';
import type { ConfigPage, UiContribution } from '../../common/plugin-contract';

export interface PluginUiEntry {
  pluginId: string;
  contributions: UiContribution[];
  configPages: ConfigPage[];
  /** Flat `"a.b.c"` dicts per locale; the client merges them under core's own keys. */
  i18n: Record<string, Record<string, string>>;
}

/**
 * Feeds the app-initializer chain that gates the splash screen, so every logged-in user needs
 * it — auth-only, no permission gate, mirroring `CountsController`. Reads the in-memory manifest
 * cache `PluginRegistryService` already keeps (never a live call to a plugin): a dead plugin's
 * socket timeout must never hold up app boot.
 */
@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard)
export class PluginUiController {
  constructor(private readonly registry: PluginRegistryService) {}

  @Get('ui')
  list(): PluginUiEntry[] {
    return this.registry
      .list()
      .filter((plugin) => plugin.kind === 'data' || this.registry.processStateOf(plugin.pluginId) === 'ready')
      .map((plugin) => ({
        pluginId: plugin.pluginId,
        contributions: plugin.manifest.ui?.contributions ?? [],
        configPages: plugin.manifest.ui?.configPages ?? [],
        i18n: plugin.manifest.i18n ?? {},
      }));
  }
}
