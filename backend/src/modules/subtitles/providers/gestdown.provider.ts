import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';

const BASE_URL = 'https://api.gestdown.info';
const USER_AGENT = 'Suitarr/1.0';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

// Gestdown uses Addic7ed-style language names
const LANG_MAP: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ro: 'Romanian',
  tr: 'Turkish',
  ar: 'Arabic',
  bg: 'Bulgarian',
  hr: 'Croatian',
  cs: 'Czech',
  da: 'Danish',
  fi: 'Finnish',
  el: 'Greek',
  he: 'Hebrew',
  hu: 'Hungarian',
  id: 'Indonesian',
  ja: 'Japanese',
  ko: 'Korean',
  no: 'Norwegian',
  ru: 'Russian',
  sr: 'Serbian',
  sl: 'Slovenian',
  sv: 'Swedish',
  th: 'Thai',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

interface GestdownShow {
  id: string;
  name: string;
  tmdbId: number | null;
}

interface GestdownSubtitle {
  subtitleId: string;
  version: string;
  completed: boolean;
  hearingImpaired: boolean;
  downloadUri: string;
  language: string;
  downloadCount: number;
  release: string | null;
}

export class GestdownProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(GestdownProvider.name);

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    // Gestdown only supports TV shows
    if (params.season == null || params.episode == null) return [];

    const lang = LANG_MAP[params.language];
    if (!lang) {
      this.logger.debug(`Gestdown: unsupported language "${params.language}"`);
      return [];
    }

    const showId = await this.resolveShowId(params);
    if (!showId) return [];

    const url = `${BASE_URL}/subtitles/get/${showId}/${params.season}/${params.episode}/${lang}`;
    const res = await this.fetchWithRetry(url);
    if (!res || !res.ok) return [];

    const body = (await res.json()) as {
      matchingSubtitles: GestdownSubtitle[];
    };

    return (body.matchingSubtitles ?? [])
      .filter((s) => s.completed)
      .map((s) => ({
        providerFileId: s.downloadUri,
        title: [params.title, s.version, s.release].filter(Boolean).join(' - '),
        language: params.language,
        forced: false,
        hearingImpaired: s.hearingImpaired,
        downloadCount: s.downloadCount,
        score: Math.min(100, Math.round(Math.log2(s.downloadCount + 1) * 10)),
        providerName: 'Gestdown',
        providerType: 'gestdown',
      }));
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    const url = `${BASE_URL}${result.providerFileId}`;
    const res = await this.fetchWithRetry(url);
    if (!res || !res.ok)
      throw new Error(`Gestdown download failed: ${res?.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(): Promise<boolean> {
    const res = await fetch(`${BASE_URL}/shows/search/test`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    return res.ok;
  }

  /**
   * Resolve the Gestdown internal show ID.
   * Strategy: search by title, then match by tmdbId for accuracy.
   */
  private async resolveShowId(
    params: SubtitleSearchParams,
  ): Promise<string | null> {
    const searchUrl = `${BASE_URL}/shows/search/${encodeURIComponent(params.title)}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      this.logger.warn(`Gestdown show search failed: ${res.status}`);
      return null;
    }

    const body = (await res.json()) as { shows: GestdownShow[] };
    if (!body.shows?.length) {
      this.logger.debug(`Gestdown: no show found for "${params.title}"`);
      return null;
    }

    // Prefer exact tmdbId match
    if (params.tmdbId) {
      const match = body.shows.find((s) => s.tmdbId === params.tmdbId);
      if (match) return match.id;
    }

    // Fallback to first result
    return body.shows[0].id;
  }

  /** Fetch with retry on HTTP 423 (rate-limited). */
  private async fetchWithRetry(url: string): Promise<Response | null> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (res.status !== 423) return res;
      this.logger.warn(
        `Gestdown rate-limited (423), retry ${attempt + 1}/${MAX_RETRIES}`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    this.logger.warn('Gestdown: max retries reached');
    return null;
  }
}
