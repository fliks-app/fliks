import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';

interface SubdlSettings {
  apiKey: string;
}

export class SubdlProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(SubdlProvider.name);

  constructor(private readonly settings: SubdlSettings) {}

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    const query = new URLSearchParams();
    if (params.imdbId) query.set('imdb_id', params.imdbId);
    if (params.tmdbId) query.set('tmdb_id', String(params.tmdbId));
    query.set('languages', params.language);
    query.set('type', params.season != null ? 'tv' : 'movie');
    if (params.season != null)
      query.set('season_number', String(params.season));
    if (params.episode != null)
      query.set('episode_number', String(params.episode));

    const res = await fetch(`https://api.subdl.com/api/v1/subtitles?${query}`, {
      headers: { 'Api-Key': this.settings.apiKey },
    });

    if (!res.ok) {
      this.logger.warn(`Subdl search failed: ${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      subtitles: {
        sd_id: number;
        release_name: string;
        language: string;
        hi: boolean;
        url: string;
        rating: number;
      }[];
    };

    return (body.subtitles ?? []).map((item) => ({
      providerFileId: String(item.sd_id),
      title: item.release_name,
      language: item.language,
      forced: false,
      hearingImpaired: item.hi,
      score: Math.min(100, Math.round((item.rating ?? 5) * 10)),
      providerName: 'Subdl',
      providerType: 'subdl',
    }));
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    const res = await fetch(
      `https://api.subdl.com/api/v1/subtitles/download/${result.providerFileId}`,
      { headers: { 'Api-Key': this.settings.apiKey } },
    );
    if (!res.ok) throw new Error(`Subdl download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(settings: Record<string, unknown>): Promise<boolean> {
    const apiKey = (settings.apiKey as string) || this.settings.apiKey;
    const res = await fetch(
      'https://api.subdl.com/api/v1/subtitles?imdb_id=tt0111161',
      {
        headers: { 'Api-Key': apiKey },
      },
    );
    return res.ok;
  }
}
