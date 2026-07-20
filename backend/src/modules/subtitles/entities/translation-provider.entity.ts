import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { TRANSLATION_ENGINES } from '../../../common/enums';
import type { TranslationEngine } from '../../../common/enums';

/**
 * An admin-configured machine-translation provider. Several can coexist (e.g. a
 * Gemini key, an OpenAI-compatible endpoint, a self-hosted LibreTranslate); the
 * user picks one at translate time. `settings` holds the engine-specific config
 * opaquely (gemini `{apiKey, model}`, openai `{baseUrl, apiKey, model}`,
 * libretranslate `{url, apiKey}`), mirroring {@link SubtitleProvider}.
 */
@Entity('translation_providers')
export class TranslationProvider extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'enum', enum: [...TRANSLATION_ENGINES] })
  engine: TranslationEngine;

  @Column({ default: true })
  enabled: boolean;

  @Column({ default: false })
  isDefault: boolean;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, unknown>;
}
