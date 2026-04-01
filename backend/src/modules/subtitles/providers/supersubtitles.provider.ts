import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';

interface SupersubtitlesSettings {
  baseUrl?: string;
}

export class SupersubtitlesProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(SupersubtitlesProvider.name);
  private readonly baseUrl: string;

  constructor(private readonly settings: SupersubtitlesSettings) {
    this.baseUrl = settings.baseUrl || 'https://www.supersubtitles.com';
  }

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    const query = new URLSearchParams();
    query.set('q', params.title);
    query.set('lang', params.language);
    if (params.year) query.set('year', String(params.year));

    const res = await fetch(`${this.baseUrl}/api/search?${query}`);
    if (!res.ok) {
      this.logger.warn(`Supersubtitles search failed: ${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      results: {
        id: string;
        title: string;
        language: string;
        hi: boolean;
        rating: number;
      }[];
    };

    return (body.results ?? []).map((item) => ({
      providerFileId: item.id,
      title: item.title,
      language: item.language,
      forced: false,
      hearingImpaired: item.hi ?? false,
      score: Math.min(100, Math.round((item.rating ?? 5) * 10)),
      providerName: 'Supersubtitles',
      providerType: 'supersubtitles',
    }));
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    const res = await fetch(
      `${this.baseUrl}/api/download/${result.providerFileId}`,
    );
    if (!res.ok)
      throw new Error(`Supersubtitles download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(settings: Record<string, unknown>): Promise<boolean> {
    const baseUrl = (settings.baseUrl as string) || this.baseUrl;
    const res = await fetch(`${baseUrl}/api/search?q=test&lang=en`);
    return res.ok;
  }
}
