import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Indexer } from './entities/indexer.entity';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TorznabService } from './torznab.service';
import { IndexerThrottle } from './indexer-throttle.service';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';
import { PluginRegistryService } from '../plugins/plugin-registry.service';

/** Strips the stored API key so it never reaches an HTTP response. */
/** Strip credentials before an indexer leaves the API. `apiKey` is the wire
 *  credential for every driver; a descriptor may name further secret fields,
 *  and those are only knowable from the plugin that declared them. */
export function redactApiKey(
  ix: Indexer,
  extraSecretKeys: readonly string[] = [],
): Indexer {
  const settings = { ...((ix.settings ?? {}) as Record<string, unknown>) };
  delete settings.apiKey;
  for (const key of extraSecretKeys) delete settings[key];
  return { ...ix, settings };
}

/** An indexer plus its live throttle state, as the settings page needs it. */
export type IndexerWithCooldown = Indexer & {
  cooldown: {
    reason: 'rate-limit' | 'failures';
    remainingMs: number;
    until: string;
    failureCount?: number;
    detail?: string;
  } | null;
};

@Injectable()
export class IndexersService {
  constructor(
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    private readonly torznab: TorznabService,
    private readonly throttle: IndexerThrottle,
    private readonly pluginRegistry: PluginRegistryService,
  ) {}

  /**
   * `implementation` is either the legacy free-form `"torznab"` value or a
   * plugin-namespaced descriptor id — checked against the registry here
   * (not a `class-validator` decorator) because the check needs live plugin
   * state. Throws, naming the value, when neither matches.
   */
  private assertKnownImplementation(implementation: string): void {
    if (implementation === 'torznab') return;
    if (this.pluginRegistry.getIndexerDescriptor(implementation)) return;
    throw new BadRequestException(
      `Unknown indexer implementation "${implementation}"`,
    );
  }

  async testConnection(
    dto: TestIndexerConnectionDto,
  ): Promise<{ ok: boolean; message: string }> {
    const apiKey = String(dto.settings?.apiKey ?? '').trim();
    const descriptor = this.pluginRegistry.getIndexerDescriptor(
      dto.implementation,
    );
    if (descriptor) {
      return this.torznab.testConnection(descriptor.endpoint, apiKey);
    }
    if (dto.implementation !== 'torznab') {
      return {
        ok: false,
        message: `Unknown indexer implementation "${dto.implementation}"`,
      };
    }
    const baseUrl = String(dto.settings?.baseUrl ?? '').trim();
    return this.torznab.testConnection(baseUrl, apiKey);
  }

  private sanitizeSettings(
    settings: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out = { ...(settings ?? {}) };
    if ('minSeeders' in out) {
      out['minSeeders'] = Math.max(
        0,
        Math.floor(Number(out['minSeeders']) || 0),
      );
    }
    return out;
  }

  async create(dto: CreateIndexerDto): Promise<Indexer> {
    this.assertKnownImplementation(dto.implementation);
    const row = this.indexerRepo.create({
      name: dto.name,
      implementation: dto.implementation,
      settings: this.sanitizeSettings(dto.settings),
      enableRss: dto.enableRss ?? true,
      enableSearch: dto.enableSearch ?? true,
      priority: dto.priority ?? 25,
      requestDelay: dto.requestDelay ?? 2,
      enabled: dto.enabled ?? true,
    });

    const saved = await this.indexerRepo.save(row);
    void this.torznab.refreshCaps(saved);
    return this.redact(saved);
  }

  /** Redaction that also covers a descriptor's own `secret` fields. Public so
   *  no caller has to remember the registry lookup and reach for the bare
   *  helper instead. */
  redact(ix: Indexer): Indexer {
    return redactApiKey(ix, this.descriptorSecretKeys(ix.implementation));
  }

  private descriptorSecretKeys(implementation: string): string[] {
    const descriptor = this.pluginRegistry.getIndexerDescriptor(implementation);
    return (descriptor?.settings ?? [])
      .filter((f) => f.secret)
      .map((f) => f.key);
  }

  async findAll(): Promise<IndexerWithCooldown[]> {
    const rows = await this.indexerRepo.find({
      order: { priority: 'ASC', id: 'ASC' },
    });
    return rows.map((ix) => {
      const cd = this.throttle.getCooldown(ix.id);
      return Object.assign(this.redact(ix), {
        cooldown: cd
          ? {
              reason: cd.reason,
              remainingMs: Math.max(0, cd.until - Date.now()),
              until: new Date(cd.until).toISOString(),
              failureCount: cd.failureCount,
              detail: cd.detail,
            }
          : null,
      });
    });
  }

  /** Lift the throttle window on one indexer. */
  async clearCooldown(id: number): Promise<{ cleared: boolean }> {
    await this.findOne(id);
    return { cleared: this.throttle.clearCooldown(id) };
  }

  /** Lift every throttle window. */
  clearAllCooldowns(): { cleared: number } {
    return { cleared: this.throttle.clearAllCooldowns() };
  }

  async findOne(id: number): Promise<Indexer> {
    const ix = await this.indexerRepo.findOne({ where: { id } });
    if (!ix) throw new NotFoundException(`Indexer #${id} not found`);
    return ix;
  }

  async update(id: number, dto: UpdateIndexerDto): Promise<Indexer> {
    const ix = await this.findOne(id);

    if (dto.name !== undefined) ix.name = dto.name;
    if (dto.implementation !== undefined) {
      this.assertKnownImplementation(dto.implementation);
      ix.implementation = dto.implementation;
    }
    if (dto.enableRss !== undefined) ix.enableRss = dto.enableRss;
    if (dto.enableSearch !== undefined) ix.enableSearch = dto.enableSearch;
    if (dto.priority !== undefined) ix.priority = dto.priority;
    if (dto.requestDelay !== undefined) ix.requestDelay = dto.requestDelay;
    if (dto.enabled !== undefined) ix.enabled = dto.enabled;
    if (dto.settings !== undefined) {
      // Blank/absent apiKey keeps the stored one instead of wiping it —
      // the client never sends the real value back on read.
      const incoming = this.sanitizeSettings(dto.settings);
      const existingApiKey = (ix.settings as Record<string, unknown>)
        ?.apiKey;
      ix.settings = { ...incoming, apiKey: incoming.apiKey || existingApiKey };
    }

    const saved = await this.indexerRepo.save(ix);
    void this.torznab.refreshCaps(saved);
    return this.redact(saved);
  }

  async remove(id: number): Promise<void> {
    const ix = await this.findOne(id);
    await this.indexerRepo.remove(ix);
  }
}
