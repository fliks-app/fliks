import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Indexer } from './entities/indexer.entity';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TorznabService } from './torznab.service';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';

@Injectable()
export class IndexersService {
  constructor(
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    private readonly torznab: TorznabService,
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
      enabled: dto.enabled ?? true,
    });

    return this.indexerRepo.save(row);
  }

  findAll(): Promise<Indexer[]> {
    return this.indexerRepo.find({
      order: { priority: 'ASC', id: 'ASC' },
    });
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
    if (dto.enabled !== undefined) ix.enabled = dto.enabled;
    if (dto.settings !== undefined)
      ix.settings = this.sanitizeSettings(dto.settings);

    return this.indexerRepo.save(ix);
  }

  async remove(id: number): Promise<void> {
    const ix = await this.findOne(id);
    await this.indexerRepo.remove(ix);
  }
}
