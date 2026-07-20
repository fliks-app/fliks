import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TranslationProvider } from './entities/translation-provider.entity';
import { CreateTranslationProviderDto } from './dto/create-translation-provider.dto';
import { UpdateTranslationProviderDto } from './dto/update-translation-provider.dto';
import { TranslationProviderFactory } from './providers/translation-provider.factory';
import { SubtitleTranslationSettingsCache } from './subtitle-translation-settings-cache.service';
import { TranslationEngine } from '../../common/enums';

/** Trigger-facing projection of an enabled provider — never carries `settings`
 *  (API keys), so it is safe to hand to a non-admin at translate time. */
export interface AvailableTranslationProvider {
  id: number;
  name: string;
  engine: TranslationEngine;
  isDefault: boolean;
}

@Injectable()
export class TranslationProviderService implements OnModuleInit {
  private readonly log = new Logger(TranslationProviderService.name);

  constructor(
    @InjectRepository(TranslationProvider)
    private readonly repo: Repository<TranslationProvider>,
    private readonly factory: TranslationProviderFactory,
    private readonly legacySettings: SubtitleTranslationSettingsCache,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedFromLegacyConfig();
  }

  async create(dto: CreateTranslationProviderDto): Promise<TranslationProvider> {
    const provider = this.repo.create({
      name: dto.name,
      engine: dto.engine,
      settings: dto.settings ?? {},
      enabled: dto.enabled ?? true,
      isDefault: dto.isDefault ?? false,
    });
    const saved = await this.repo.save(provider);
    if (saved.isDefault) await this.clearOtherDefaults(saved.id);
    return this.findOne(saved.id);
  }

  findAll(): Promise<TranslationProvider[]> {
    return this.repo.find({ order: { isDefault: 'DESC', name: 'ASC' } });
  }

  async findOne(id: number): Promise<TranslationProvider> {
    const provider = await this.repo.findOne({ where: { id } });
    if (!provider)
      throw new NotFoundException(`TranslationProvider #${id} not found`);
    return provider;
  }

  findEnabled(): Promise<TranslationProvider[]> {
    return this.repo.find({
      where: { enabled: true },
      order: { isDefault: 'DESC', id: 'ASC' },
    });
  }

  /** The provider used when a translate call omits `providerId`: the enabled
   *  default, else the first enabled provider, else null. */
  async findDefault(): Promise<TranslationProvider | null> {
    const enabled = await this.findEnabled();
    return enabled.find((p) => p.isDefault) ?? enabled[0] ?? null;
  }

  async listAvailable(): Promise<AvailableTranslationProvider[]> {
    const enabled = await this.findEnabled();
    return enabled.map((p) => ({
      id: p.id,
      name: p.name,
      engine: p.engine,
      isDefault: p.isDefault,
    }));
  }

  async update(
    id: number,
    dto: UpdateTranslationProviderDto,
  ): Promise<TranslationProvider> {
    const provider = await this.findOne(id);
    if (dto.name !== undefined) provider.name = dto.name;
    if (dto.engine !== undefined) provider.engine = dto.engine;
    if (dto.settings !== undefined) provider.settings = dto.settings;
    if (dto.enabled !== undefined) provider.enabled = dto.enabled;
    if (dto.isDefault !== undefined) provider.isDefault = dto.isDefault;
    const saved = await this.repo.save(provider);
    if (dto.isDefault === true) await this.clearOtherDefaults(saved.id);
    return this.findOne(saved.id);
  }

  async remove(id: number): Promise<void> {
    const provider = await this.findOne(id);
    const wasDefault = provider.isDefault;
    await this.repo.remove(provider);
    if (wasDefault) await this.promoteNextDefault();
  }

  async testProvider(id: number): Promise<{ ok: boolean; error?: string }> {
    const provider = await this.findOne(id);
    return this.testConnection(provider.engine, provider.settings);
  }

  /** One short live round-trip through the engine so the admin can confirm the
   *  config works. Uses the normal retry path (a transient 429 shouldn't read
   *  as broken) but a 2-line payload to keep it cheap and avoid a single-line
   *  count-mismatch split. */
  async testConnection(
    engine: TranslationEngine,
    settings: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      this.factory.validateConfig(engine, settings);
      const out = await this.factory.translate(
        engine,
        ['Hello.', 'Good morning.'],
        { sourceLanguage: 'en', targetLanguage: 'fr', context: {} },
        settings,
      );
      if (!out?.length) return { ok: false, error: 'Empty translation response' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async clearOtherDefaults(keepId: number): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(TranslationProvider)
      .set({ isDefault: false })
      .where('id != :keepId', { keepId })
      .andWhere('"isDefault" = true')
      .execute();
  }

  private async promoteNextDefault(): Promise<void> {
    const next = await this.repo.findOne({
      where: { enabled: true },
      order: { id: 'ASC' },
    });
    if (next && !next.isDefault) {
      next.isDefault = true;
      await this.repo.save(next);
    }
  }

  /** On first boot with no providers, migrate the single legacy
   *  `subtitle_translation_*` engine config into one enabled default provider so
   *  installs that were already translating keep working with zero admin action.
   *  Idempotent and table-safe (no-op once any provider exists). */
  private async seedFromLegacyConfig(): Promise<void> {
    try {
      if ((await this.repo.count()) > 0) return;
      const legacy = await this.legacySettings.get();
      const settings = this.legacyEngineSettings(legacy);
      try {
        this.factory.validateConfig(legacy.engine, settings);
      } catch {
        return; // legacy config isn't usable — nothing worth seeding
      }
      await this.repo.save(
        this.repo.create({
          name: this.engineLabel(legacy.engine),
          engine: legacy.engine,
          settings,
          enabled: true,
          isDefault: true,
        }),
      );
      this.log.log(
        `Seeded a "${legacy.engine}" translation provider from legacy settings`,
      );
    } catch (err) {
      // Table may not exist yet under some startup orderings; a later boot seeds.
      this.log.warn(`Translation-provider seed skipped: ${err}`);
    }
  }

  private legacyEngineSettings(
    legacy: Awaited<ReturnType<SubtitleTranslationSettingsCache['get']>>,
  ): Record<string, unknown> {
    if (legacy.engine === 'openai') return { ...legacy.openai };
    if (legacy.engine === 'libretranslate') return { ...legacy.libretranslate };
    return { ...legacy.gemini };
  }

  private engineLabel(engine: TranslationEngine): string {
    if (engine === 'openai') return 'OpenAI-compatible';
    if (engine === 'libretranslate') return 'LibreTranslate';
    return 'Gemini';
  }
}
