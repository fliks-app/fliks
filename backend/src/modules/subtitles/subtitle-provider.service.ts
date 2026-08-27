import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { CreateSubtitleProviderDto } from './dto/create-subtitle-provider.dto';
import { UpdateSubtitleProviderDto } from './dto/update-subtitle-provider.dto';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { SubtitleProviderTestResult } from './providers/subtitle-provider.interface';
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
  private readonly logger = new Logger(SubtitleProviderService.name);

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

  async testProvider(id: number): Promise<SubtitleProviderTestResult> {
    const provider = await this.findOne(id);
    return this.testConnection(provider.type, provider.settings);
  }

  // Every probe funnels through here: the implementations let their failures throw so the
  // reason survives, and this is the one place that turns it into a verdict and a log line.
  async testConnection(
    type: import('../../common/enums').SubtitleProviderType,
    settings: Record<string, unknown>,
  ): Promise<SubtitleProviderTestResult> {
    try {
      const result = await this.factory
        .create(type, settings)
        .testConnection(settings);
      if (result.ok) {
        this.logger.log(
          `Connection test succeeded for subtitle provider "${type}"`,
        );
      } else {
        this.logger.warn(
          `Connection test failed for subtitle provider "${type}": ${result.detail ?? 'no detail'}`,
        );
      }
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Connection test errored for subtitle provider "${type}": ${detail}`,
      );
      return { ok: false, detail };
    }
  }
}
