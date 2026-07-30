import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Indexer } from './entities/indexer.entity';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TorznabService } from './torznab.service';
import { IndexerThrottle } from './indexer-throttle.service';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';

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
  ) {}

  async testConnection(
    dto: TestIndexerConnectionDto,
  ): Promise<{ ok: boolean; message: string }> {
    const baseUrl = String(dto.settings?.baseUrl ?? '').trim();
    const apiKey = String(dto.settings?.apiKey ?? '').trim();
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
    return saved;
  }

  async findAll(): Promise<IndexerWithCooldown[]> {
    const rows = await this.indexerRepo.find({
      order: { priority: 'ASC', id: 'ASC' },
    });
    return rows.map((ix) => {
      const cd = this.throttle.getCooldown(ix.id);
      return Object.assign(ix, {
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
    if (dto.implementation !== undefined)
      ix.implementation = dto.implementation;
    if (dto.enableRss !== undefined) ix.enableRss = dto.enableRss;
    if (dto.enableSearch !== undefined) ix.enableSearch = dto.enableSearch;
    if (dto.priority !== undefined) ix.priority = dto.priority;
    if (dto.requestDelay !== undefined) ix.requestDelay = dto.requestDelay;
    if (dto.enabled !== undefined) ix.enabled = dto.enabled;
    if (dto.settings !== undefined)
      ix.settings = this.sanitizeSettings(dto.settings);

    const saved = await this.indexerRepo.save(ix);
    void this.torznab.refreshCaps(saved);
    return saved;
  }

  async remove(id: number): Promise<void> {
    const ix = await this.findOne(id);
    await this.indexerRepo.remove(ix);
  }
}
