import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_TRANSLATION_MODEL, TranslationEngine } from '../../common/enums';

export { DEFAULT_TRANSLATION_MODEL };
export type { TranslationEngine };

/** Resolved subtitle-translation configuration read from the key/value store. */
export interface ResolvedTranslationSettings {
  enabled: boolean;
  engine: TranslationEngine;
  maxConcurrency: number;
  gemini: { apiKey: string; model: string };
  openai: { baseUrl: string; apiKey: string; model: string };
  libretranslate: { url: string; apiKey: string };
}

function parseEngine(raw: string | null): TranslationEngine {
  return raw === 'openai' || raw === 'libretranslate' ? raw : 'gemini';
}

/** Resolves + caches the subtitle machine-translation settings. The translation
 *  service reads the config once per run instead of hitting the key/value store
 *  repeatedly; the cache is invalidated when the admin changes any
 *  `subtitle_translation_*` setting, so a new value takes effect without a
 *  restart. Mirrors {@link MetadataSettingsCache}'s epoch-guarded memoisation. */
@Injectable()
export class SubtitleTranslationSettingsCache implements OnModuleInit {
  constructor(private readonly settings: SettingsService) {}

  private cache: ResolvedTranslationSettings | null = null;
  private inflight: Promise<ResolvedTranslationSettings> | null = null;
  /** Bumped on every change so an in-flight load that was invalidated mid-flight
   *  doesn't commit its now-stale value. */
  private epoch = 0;

  onModuleInit(): void {
    this.settings.addChangeListener((key) => {
      if (key.startsWith('subtitle_translation_')) {
        this.cache = null;
        this.inflight = null;
        this.epoch++;
      }
    });
  }

  async get(): Promise<ResolvedTranslationSettings> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    const epoch = this.epoch;
    this.inflight = (async () => {
      try {
        const v = await this.load();
        if (this.epoch === epoch) this.cache = v;
        return v;
      } finally {
        // Clear so a rejected load can be retried, and so a fresh read after an
        // invalidation isn't handed this superseded promise.
        if (this.epoch === epoch) this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async load(): Promise<ResolvedTranslationSettings> {
    const [
      enabled,
      engine,
      maxConcurrency,
      geminiKey,
      geminiModel,
      openaiBaseUrl,
      openaiKey,
      openaiModel,
      libreUrl,
      libreKey,
    ] = await Promise.all([
      this.settings.get('subtitle_translation_enabled'),
      this.settings.get('subtitle_translation_engine'),
      this.settings.get('subtitle_translation_max_concurrency'),
      this.settings.get('subtitle_translation_gemini_api_key'),
      this.settings.get('subtitle_translation_gemini_model'),
      this.settings.get('subtitle_translation_openai_base_url'),
      this.settings.get('subtitle_translation_openai_api_key'),
      this.settings.get('subtitle_translation_openai_model'),
      this.settings.get('subtitle_translation_libretranslate_url'),
      this.settings.get('subtitle_translation_libretranslate_api_key'),
    ]);
    const parsedConcurrency = Number(maxConcurrency ?? '1');
    return {
      enabled: enabled === 'true',
      engine: parseEngine(engine),
      maxConcurrency:
        Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
          ? Math.floor(parsedConcurrency)
          : 1,
      gemini: {
        apiKey: (geminiKey ?? '').trim(),
        model: (geminiModel ?? '').trim() || DEFAULT_TRANSLATION_MODEL,
      },
      openai: {
        baseUrl: (openaiBaseUrl ?? '').trim(),
        apiKey: (openaiKey ?? '').trim(),
        model: (openaiModel ?? '').trim(),
      },
      libretranslate: {
        url: (libreUrl ?? '').trim(),
        apiKey: (libreKey ?? '').trim(),
      },
    };
  }
}
