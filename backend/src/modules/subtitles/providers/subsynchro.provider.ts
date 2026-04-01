import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';

interface SubsynchroSettings {
  baseUrl?: string;
}

export class SubsynchroProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(SubsynchroProvider.name);
  private readonly baseUrl: string;

  constructor(private readonly settings: SubsynchroSettings) {
    this.baseUrl = settings.baseUrl || 'https://www.subsynchro.com';
  }

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    const query = new URLSearchParams();
    query.set('q', params.title);
    if (params.year) query.set('year', String(params.year));

    const res = await fetch(`${this.baseUrl}/api/search?${query}`);
    if (!res.ok) {
      this.logger.warn(`Subsynchro search failed: ${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      results: {
        id: string;
        title: string;
        language: string;
        download_url: string;
        rating: number;
      }[];
    };

    return (body.results ?? []).map((item) => ({
      providerFileId: item.id,
      title: item.title,
      language: item.language || 'fr',
      forced: false,
      hearingImpaired: false,
      score: Math.min(100, Math.round((item.rating ?? 5) * 10)),
      providerName: 'Subsynchro',
      providerType: 'subsynchro',
    }));
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    const res = await fetch(
      `${this.baseUrl}/api/download/${result.providerFileId}`,
    );
    if (!res.ok) throw new Error(`Subsynchro download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(settings: Record<string, unknown>): Promise<boolean> {
    const baseUrl = (settings.baseUrl as string) || this.baseUrl;
    const res = await fetch(`${baseUrl}/api/search?q=test`);
    return res.ok;
  }
}
