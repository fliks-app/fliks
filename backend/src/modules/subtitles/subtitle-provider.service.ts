import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { Tag } from '../tags/entities/tag.entity';
import { CreateSubtitleProviderDto } from './dto/create-subtitle-provider.dto';
import { UpdateSubtitleProviderDto } from './dto/update-subtitle-provider.dto';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';

@Injectable()
export class SubtitleProviderService {
  constructor(
    @InjectRepository(SubtitleProvider)
    private readonly repo: Repository<SubtitleProvider>,
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
    private readonly factory: SubtitleProviderFactory,
  ) {}

  async create(dto: CreateSubtitleProviderDto): Promise<SubtitleProvider> {
    const provider = this.repo.create({
      name: dto.name,
      type: dto.type,
      settings: dto.settings ?? {},
      enabled: dto.enabled ?? true,
      priority: dto.priority ?? 25,
    });
    if (dto.tagIds?.length) {
      provider.tags = await this.tagRepo.find({
        where: { id: In(dto.tagIds) },
      });
    }
    return this.repo.save(provider);
  }

  findAll(): Promise<SubtitleProvider[]> {
    return this.repo.find({ order: { priority: 'ASC', name: 'ASC' } });
  }

  async findOne(id: number): Promise<SubtitleProvider> {
    const provider = await this.repo.findOne({ where: { id } });
    if (!provider)
      throw new NotFoundException(`SubtitleProvider #${id} not found`);
    return provider;
  }

  findEnabled(): Promise<SubtitleProvider[]> {
    return this.repo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });
  }

  async update(
    id: number,
    dto: UpdateSubtitleProviderDto,
  ): Promise<SubtitleProvider> {
    const provider = await this.findOne(id);
    if (dto.name !== undefined) provider.name = dto.name;
    if (dto.type !== undefined) provider.type = dto.type;
    if (dto.settings !== undefined) provider.settings = dto.settings;
    if (dto.enabled !== undefined) provider.enabled = dto.enabled;
    if (dto.priority !== undefined) provider.priority = dto.priority;
    if (dto.tagIds) {
      provider.tags = await this.tagRepo.find({
        where: { id: In(dto.tagIds) },
      });
    }
    return this.repo.save(provider);
  }

  async remove(id: number): Promise<void> {
    const provider = await this.findOne(id);
    await this.repo.remove(provider);
  }

  async testProvider(id: number): Promise<boolean> {
    const provider = await this.findOne(id);
    const impl = this.factory.create(provider.type, provider.settings);
    return impl.testConnection(provider.settings);
  }

  async testConnection(
    type: import('../../common/enums').SubtitleProviderType,
    settings: Record<string, unknown>,
  ): Promise<boolean> {
    const impl = this.factory.create(type, settings);
    return impl.testConnection(settings);
  }
}
