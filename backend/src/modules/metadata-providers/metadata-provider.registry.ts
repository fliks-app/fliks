import { Injectable } from '@nestjs/common';
import { IMetadataProvider } from './interfaces/metadata-provider.interface';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MetadataProviderRegistry {
  private readonly providers: Map<string, IMetadataProvider>;

  constructor(
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {
    this.providers = new Map<string, IMetadataProvider>([
      ['tmdb', tmdb],
      ['tvdb', tvdb],
    ]);
  }

  /** Get a provider by name, or undefined if unknown. */
  get(name: string): IMetadataProvider | undefined {
    return this.providers.get(name);
  }

  /** Default provider (TMDB). */
  getDefault(): IMetadataProvider {
    return this.tmdb;
  }

  /** Get all providers whose API key is configured. */
  async getAvailable(): Promise<IMetadataProvider[]> {
    const available: IMetadataProvider[] = [];
    if (this.config.get<string>('TMDB_API_KEY', '')) {
      available.push(this.tmdb);
    }
    const tvdbKey = await this.settings.get('tvdb_api_key');
    if (tvdbKey) {
      available.push(this.tvdb);
    }
    return available;
  }

  /** Check if a provider has its API key configured. */
  async isAvailable(name: string): Promise<boolean> {
    if (name === 'tmdb') return !!this.config.get<string>('TMDB_API_KEY', '');
    if (name === 'tvdb') return !!(await this.settings.get('tvdb_api_key'));
    return false;
  }

  /** Get the fallback provider (the other available one). */
  async getFallback(preferred: string): Promise<IMetadataProvider | null> {
    const available = await this.getAvailable();
    return available.find((p) => p.name !== preferred) ?? null;
  }

  /** Resolve a provider: preferred if available, else fallback to default. */
  async resolve(preferred: string | null): Promise<IMetadataProvider> {
    if (preferred && (await this.isAvailable(preferred))) {
      return this.providers.get(preferred)!;
    }
    return this.getDefault();
  }
}
