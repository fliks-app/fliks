import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Indexer } from './entities/indexer.entity';
import { Tag } from '../tags/entities/tag.entity';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TorznabService } from './torznab.service';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';

@Injectable()
export class IndexersService {
  constructor(
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
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
    const { tagIds, ...fields } = dto;
    const row = this.indexerRepo.create({
      name: fields.name,
      implementation: fields.implementation,
      settings: this.sanitizeSettings(dto.settings),
      enableRss: fields.enableRss ?? true,
      enableSearch: fields.enableSearch ?? true,
      priority: fields.priority ?? 25,
      enabled: fields.enabled ?? true,
    });

    if (tagIds?.length) {
      row.tags = await this.tagRepo.find({ where: { id: In(tagIds) } });
    }

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

    const { tagIds, ...patch } = dto;
    if (patch.name !== undefined) ix.name = patch.name;
    if (patch.implementation !== undefined)
      ix.implementation = patch.implementation;
    if (patch.enableRss !== undefined) ix.enableRss = patch.enableRss;
    if (patch.enableSearch !== undefined) ix.enableSearch = patch.enableSearch;
    if (patch.priority !== undefined) ix.priority = patch.priority;
    if (patch.enabled !== undefined) ix.enabled = patch.enabled;
    if (patch.settings !== undefined)
      ix.settings = this.sanitizeSettings(patch.settings);

    if (tagIds !== undefined) {
      ix.tags = tagIds.length
        ? await this.tagRepo.find({ where: { id: In(tagIds) } })
        : [];
    }

    return this.indexerRepo.save(ix);
  }

  async remove(id: number): Promise<void> {
    const ix = await this.findOne(id);
    await this.indexerRepo.remove(ix);
  }
}
