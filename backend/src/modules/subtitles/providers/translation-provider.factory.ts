import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DEFAULT_TRANSLATION_MODEL,
  TranslationEngine,
} from '../../../common/enums';
import { TranslationRequest } from '../translation-core';
import { GeminiConfig, translateWithGemini } from '../gemini-translator';
import { OpenAiConfig, translateWithOpenAi } from '../openai-translator';
import {
  LibreTranslateConfig,
  translateWithLibreTranslate,
} from '../libretranslate-translator';

type ProgressCb = (done: number, total: number) => void;

/**
 * Resolves a translation provider's opaque `settings` into the typed per-engine
 * config and dispatches the actual translation. Mirrors
 * {@link SubtitleProviderFactory} for the download providers — one place that
 * knows how each engine is configured and invoked, so the service stays
 * engine-agnostic.
 */
@Injectable()
export class TranslationProviderFactory {
  private str(settings: Record<string, unknown>, key: string): string {
    const v = settings?.[key];
    return typeof v === 'string' ? v.trim() : '';
  }

  private geminiConfig(settings: Record<string, unknown>): GeminiConfig {
    return {
      apiKey: this.str(settings, 'apiKey'),
      model: this.str(settings, 'model') || DEFAULT_TRANSLATION_MODEL,
    };
  }

  private openAiConfig(settings: Record<string, unknown>): OpenAiConfig {
    return {
      baseUrl: this.str(settings, 'baseUrl'),
      apiKey: this.str(settings, 'apiKey'),
      model: this.str(settings, 'model'),
    };
  }

  private libreConfig(settings: Record<string, unknown>): LibreTranslateConfig {
    return {
      url: this.str(settings, 'url'),
      apiKey: this.str(settings, 'apiKey'),
    };
  }

  /**
   * Assert a provider is usable before work starts. The requirements are
   * deliberately asymmetric: Gemini needs an API key (model has a default);
   * an OpenAI-compatible endpoint needs a base URL and model but not a key
   * (local Ollama is keyless); LibreTranslate needs only a URL (self-hosted
   * instances are usually keyless).
   */
  validateConfig(
    engine: TranslationEngine,
    settings: Record<string, unknown>,
  ): void {
    if (engine === 'gemini' && !this.geminiConfig(settings).apiKey) {
      throw new BadRequestException('Gemini API key is not set');
    }
    if (engine === 'openai') {
      const c = this.openAiConfig(settings);
      if (!c.baseUrl || !c.model) {
        throw new BadRequestException(
          'An OpenAI-compatible base URL and model are required',
        );
      }
    }
    if (engine === 'libretranslate' && !this.libreConfig(settings).url) {
      throw new BadRequestException('The LibreTranslate URL is not set');
    }
  }

  /** The model string that will actually be used (for provenance snapshots). */
  resolveModel(
    engine: TranslationEngine,
    settings: Record<string, unknown>,
  ): string | null {
    if (engine === 'gemini') return this.geminiConfig(settings).model;
    if (engine === 'openai') return this.openAiConfig(settings).model;
    return null;
  }

  async translate(
    engine: TranslationEngine,
    texts: string[],
    req: TranslationRequest,
    settings: Record<string, unknown>,
    onProgress?: ProgressCb,
  ): Promise<string[]> {
    if (engine === 'openai') {
      return translateWithOpenAi(texts, req, this.openAiConfig(settings), onProgress);
    }
    if (engine === 'libretranslate') {
      return translateWithLibreTranslate(
        texts,
        req,
        this.libreConfig(settings),
        onProgress,
      );
    }
    return translateWithGemini(texts, req, this.geminiConfig(settings), onProgress);
  }
}
