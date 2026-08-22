import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { CreateSubtitleProviderDto } from './dto/create-subtitle-provider.dto';
import { UpdateSubtitleProviderDto } from './dto/update-subtitle-provider.dto';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { mergeSecretFields, redactSecretFields } from '../../common/utils/secret-fields.util';

/** The credential keys the provider implementations read; `username` is an identifier, not a secret. */
export const SUBTITLE_PROVIDER_SECRET_FIELDS = [
  { key: 'password', secret: true },
  { key: 'apiKey', secret: true },
] as const;

/** Strips stored credentials from a provider before it reaches an HTTP response. */
export function redactProviderSecrets(provider: SubtitleProvider): SubtitleProvider {
  return { ...provider, settings: redactSecretFields(provider.settings, SUBTITLE_PROVIDER_SECRET_FIELDS) };
}

@Injectable()
export class SubtitleProviderService {
  constructor(
    @InjectRepository(SubtitleProvider)
    private readonly repo: Repository<SubtitleProvider>,
    private readonly factory: SubtitleProviderFactory,
  ) {}

  async create(dto: CreateSubtitleProviderDto): Promise<SubtitleProvider> {
    const provider = this.repo.create({
      name: dto.name,
      type: dto.type,
      settings: mergeSecretFields(undefined, dto.settings ?? {}, SUBTITLE_PROVIDER_SECRET_FIELDS),
      enabled: dto.enabled ?? true,
      priority: dto.priority ?? 25,
    });
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
    // A response never carries the stored credential, so an incoming blank means
    // "unchanged"; an explicit null is how a client erases it.
    if (dto.settings !== undefined) {
      provider.settings = mergeSecretFields(provider.settings, dto.settings, SUBTITLE_PROVIDER_SECRET_FIELDS);
    }
    if (dto.enabled !== undefined) provider.enabled = dto.enabled;
    if (dto.priority !== undefined) provider.priority = dto.priority;
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
