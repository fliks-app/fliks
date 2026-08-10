import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginCatalogClientService, type CatalogRefreshResult } from './plugin-catalog-client.service';
import { PluginInstallService, type PluginInspectReport } from './plugin-install.service';
import { PluginInstallException } from './plugin-install.exception';
import { InspectFromCatalogDto } from './dto/inspect-from-catalog.dto';
import { CreatePluginSourceDto } from './dto/create-plugin-source.dto';
import { UpdatePluginSourceDto } from './dto/update-plugin-source.dto';
import type { FilteredCatalog } from './catalog/catalog';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

/** One `plugin_sources` row shaped for the admin list — never the raw `publicKey` bytes. */
export interface PluginSourceSummary {
  id: number;
  url: string;
  enabled: boolean;
  hasPinnedKey: boolean;
  lastRefreshedAt: Date | null;
  lastRefreshError: string | null;
  pluginCount: number;
}

function toSummary(source: PluginSource): PluginSourceSummary {
  const catalog = source.cachedCatalog as unknown as FilteredCatalog | null;
  return {
    id: source.id,
    url: source.url,
    enabled: source.enabled,
    hasPinnedKey: source.publicKey !== null,
    lastRefreshedAt: source.lastRefreshedAt,
    lastRefreshError: source.lastRefreshError,
    pluginCount: catalog?.plugins.length ?? 0,
  };
}

/** CRUD for `plugin_sources`, plus manual refresh, cached-catalog read and inspect-from-catalog. Admin-only. */
@Controller('plugins/sources')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginSourcesController {
  constructor(
    @InjectRepository(PluginSource)
    private readonly sourceRepo: Repository<PluginSource>,
    private readonly catalogClient: PluginCatalogClientService,
    private readonly installService: PluginInstallService,
  ) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async list(): Promise<PluginSourceSummary[]> {
    const sources = await this.sourceRepo.find({ order: { id: 'ASC' } });
    return sources.map(toSummary);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async create(@Body() dto: CreatePluginSourceDto): Promise<PluginSourceSummary> {
    this.assertHttpsUrl(dto.url);
    await this.assertUniqueUrl(dto.url);
    const publicKey = this.parsePublicKey(dto.publicKey);

    const source = this.sourceRepo.create({ url: dto.url, enabled: dto.enabled ?? true, publicKey });
    return toSummary(await this.sourceRepo.save(source));
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePluginSourceDto): Promise<PluginSourceSummary> {
    const source = await this.findOrThrow(id);

    if (dto.url !== undefined && dto.url !== source.url) {
      this.assertHttpsUrl(dto.url);
      await this.assertUniqueUrl(dto.url, id);
      source.url = dto.url;
    }
    if (dto.publicKey !== undefined) source.publicKey = this.parsePublicKey(dto.publicKey);
    if (dto.enabled !== undefined) source.enabled = dto.enabled;

    return toSummary(await this.sourceRepo.save(source));
  }

  /** No FK references `plugin_sources` — a cached catalog is just a jsonb column that disappears with the row. */
  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    const source = await this.findOrThrow(id);
    await this.sourceRepo.remove(source);
  }

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

  /** Fetches + verifies + stages, same as a manual upload's `inspect`; `POST /plugins/import/confirm` promotes it. */
  @Post(':id/inspect')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async inspect(@Param('id', ParseIntPipe) id: number, @Body() dto: InspectFromCatalogDto): Promise<PluginInspectReport> {
    const source = await this.findOrThrow(id);
    return this.installService.inspectFromCatalog(source, dto.pluginId, dto.version);
  }

  private async findOrThrow(id: number): Promise<PluginSource> {
    const source = await this.sourceRepo.findOne({ where: { id } });
    if (!source) throw new NotFoundException(`Plugin source #${id} not found`);
    return source;
  }

  private assertHttpsUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PluginInstallException(HttpStatus.BAD_REQUEST, 'PLUGIN_SOURCE_INSECURE_URL', `"${url}" is not a valid URL`);
    }
    if (parsed.protocol !== 'https:') {
      throw new PluginInstallException(HttpStatus.BAD_REQUEST, 'PLUGIN_SOURCE_INSECURE_URL', `source url "${url}" must be https`);
    }
  }

  private async assertUniqueUrl(url: string, excludeId?: number): Promise<void> {
    const existing = await this.sourceRepo.findOne({ where: { url } });
    if (existing && existing.id !== excludeId) {
      throw new PluginInstallException(HttpStatus.CONFLICT, 'PLUGIN_SOURCE_DUPLICATE_URL', `a source for "${url}" already exists`);
    }
  }

  private parsePublicKey(base64: string | null | undefined): Buffer | null {
    if (base64 === null || base64 === undefined) return null;
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) {
      throw new PluginInstallException(
        HttpStatus.BAD_REQUEST,
        'PLUGIN_SOURCE_BAD_KEY',
        `publicKey must be base64-encoded and decode to exactly 32 bytes, got ${key.length}`,
      );
    }
    return key;
  }
}
