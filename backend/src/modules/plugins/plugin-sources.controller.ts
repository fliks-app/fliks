import { Controller, Get, Post, Param, ParseIntPipe, NotFoundException, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginCatalogClientService, type CatalogRefreshResult } from './plugin-catalog-client.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

/** Manual refresh and cached-catalog read for one `plugin_sources` row. Admin-only. */
@Controller('plugins/sources')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginSourcesController {
  constructor(
    @InjectRepository(PluginSource)
    private readonly sourceRepo: Repository<PluginSource>,
    private readonly catalogClient: PluginCatalogClientService,
  ) {}

  @Get(':id/catalog')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async getCatalog(@Param('id', ParseIntPipe) id: number): Promise<{
    cachedCatalog: Record<string, unknown> | null;
    lastRefreshedAt: Date | null;
    lastRefreshError: string | null;
  }> {
    const source = await this.findOrThrow(id);
    return {
      cachedCatalog: source.cachedCatalog,
      lastRefreshedAt: source.lastRefreshedAt,
      lastRefreshError: source.lastRefreshError,
    };
  }

  @Post(':id/refresh')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async refresh(@Param('id', ParseIntPipe) id: number): Promise<CatalogRefreshResult> {
    const source = await this.findOrThrow(id);
    return this.catalogClient.refreshSource(source);
  }

  private async findOrThrow(id: number): Promise<PluginSource> {
    const source = await this.sourceRepo.findOne({ where: { id } });
    if (!source) throw new NotFoundException(`Plugin source #${id} not found`);
    return source;
  }
}
