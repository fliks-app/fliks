import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  resolveMetadataLanguage,
  type ResolvedMetadataLanguage,
} from './metadata-language';

/** Per-library override; each field falls back to the global setting when null. */
export interface MetadataLanguageOverride {
  language?: string | null;
  region?: string | null;
}

interface GlobalMetadataLanguage {
  language: string | null;
  region: string | null;
}

/** Resolves + caches the configured metadata language/region for the providers.
 *  A library import/refresh (dozens of provider calls) reads the global setting
 *  once; the cache is invalidated when the admin changes the language/region
 *  setting, so a new value takes effect without a restart. Per-library overrides
 *  are merged per call in {@link resolve}. */
@Injectable()
export class MetadataSettingsCache implements OnModuleInit {
  constructor(private readonly settings: SettingsService) {}

  private cache: GlobalMetadataLanguage | null = null;
  private inflight: Promise<GlobalMetadataLanguage> | null = null;
  /** Bumped on every change so an in-flight load that was invalidated mid-flight
   *  doesn't commit its now-stale value. */
  private epoch = 0;

  onModuleInit(): void {
    this.settings.addChangeListener((key) => {
      if (key === 'metadata_language' || key === 'metadata_region') {
        this.cache = null;
        this.inflight = null;
        this.epoch++;
      }
    });
  }

  /** Effective language/region for a call. Each field of the optional per-library
   *  override wins over the global setting when set. */
  async resolve(
    override?: MetadataLanguageOverride,
  ): Promise<ResolvedMetadataLanguage> {
    const g = await this.getGlobal();
    return resolveMetadataLanguage(
      override?.language ?? g.language,
      override?.region ?? g.region,
    );
  }

  private async getGlobal(): Promise<GlobalMetadataLanguage> {
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

  private async load(): Promise<GlobalMetadataLanguage> {
    const [language, region] = await Promise.all([
      this.settings.get('metadata_language'),
      this.settings.get('metadata_region'),
    ]);
    return { language, region };
  }
}
