import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  resolveMetadataLanguage,
  type ResolvedMetadataLanguage,
} from './metadata-language';

/** Resolves + caches the configured metadata language for the providers, so a
 *  library import/refresh (dozens of provider calls) resolves it once. The
 *  cache is invalidated when the admin changes the `metadata_language` setting,
 *  so the new language takes effect without a restart. */
@Injectable()
export class MetadataSettingsCache implements OnModuleInit {
  constructor(private readonly settings: SettingsService) {}

  private cache: ResolvedMetadataLanguage | null = null;
  private inflight: Promise<ResolvedMetadataLanguage> | null = null;
  /** Bumped on every change so an in-flight load that was invalidated mid-flight
   *  doesn't commit its now-stale value. */
  private epoch = 0;

  onModuleInit(): void {
    this.settings.addChangeListener((key) => {
      if (key === 'metadata_language') {
        this.cache = null;
        this.inflight = null;
        this.epoch++;
      }
    });
  }

  async getLanguage(): Promise<ResolvedMetadataLanguage> {
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

  private async load(): Promise<ResolvedMetadataLanguage> {
    return resolveMetadataLanguage(await this.settings.get('metadata_language'));
  }
}
