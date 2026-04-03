import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';
import { isRateLimited, rateLimitedFetch } from './rate-limiter';
import { extractSubtitleFromZip } from './zip-utils';

const PROVIDER_TYPE = 'subdl';

interface SubdlSettings {
  apiKey: string;
}

interface SubdlResponse {
  status: boolean;
  error?: string;
  subtitles?: {
    sd_id: number;
    release_name: string;
    language: string;
    hi: boolean;
    url: string;
    rating: number;
  }[];
}

export class SubdlProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(SubdlProvider.name);

  constructor(private readonly settings: SubdlSettings) {}

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    if (isRateLimited(PROVIDER_TYPE)) return [];

    const query = new URLSearchParams();
    query.set('api_key', this.settings.apiKey);
    if (params.imdbId) query.set('imdb_id', params.imdbId);
    if (params.tmdbId) query.set('tmdb_id', String(params.tmdbId));
    query.set('languages', params.language);
    query.set('type', params.season != null ? 'tv' : 'movie');
    if (params.season != null)
      query.set('season_number', String(params.season));
    if (params.episode != null)
      query.set('episode_number', String(params.episode));
    query.set('subs_per_page', '30');

    const res = await rateLimitedFetch(
      PROVIDER_TYPE,
      `https://api.subdl.com/api/v1/subtitles?${query}`,
      { headers: { 'User-Agent': 'Suitarr/1.0' } },
    );

    if (!res) return [];

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`Subdl search failed: ${res.status} — ${text}`);
      return [];
    }

    const body = (await res.json()) as SubdlResponse;

    if (!body.status) {
      if (body.error && /can't find/i.test(body.error)) {
        this.logger.debug(`Subdl: ${body.error}`);
      } else {
        this.logger.warn(`Subdl API error: ${body.error}`);
      }
      return [];
    }

    return (body.subtitles ?? []).map((item) => ({
      providerFileId: item.url,
      title: item.release_name,
      language: item.language,
      forced: false,
      hearingImpaired: item.hi,
      score: Math.min(100, Math.round((item.rating ?? 5) * 10)),
      providerName: 'Subdl',
      providerType: PROVIDER_TYPE,
    }));
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    if (isRateLimited(PROVIDER_TYPE)) {
      throw new Error('Subdl is rate-limited, try again later');
    }

    // providerFileId contains the relative URL path from search results
    const dlUrl = `https://dl.subdl.com${result.providerFileId}`;
    const res = await rateLimitedFetch(
      PROVIDER_TYPE,
      dlUrl,
      { headers: { 'User-Agent': 'Suitarr/1.0' } },
    );

    if (!res || !res.ok) {
      throw new Error(`Subdl download failed: ${res?.status ?? 'rate-limited'}`);
    }

    const zipBuf = Buffer.from(await res.arrayBuffer());
    return extractSubtitleFromZip(zipBuf);
  }

  async testConnection(settings: Record<string, unknown>): Promise<boolean> {
    const apiKey = (settings.apiKey as string) || this.settings.apiKey;
    const query = new URLSearchParams({
      api_key: apiKey,
      imdb_id: 'tt0111161',
    });
    const res = await fetch(`https://api.subdl.com/api/v1/subtitles?${query}`, {
      headers: { 'User-Agent': 'Suitarr/1.0' },
    });
    return res.ok;
  }
}
