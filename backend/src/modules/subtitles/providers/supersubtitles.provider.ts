import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';

const BASE_URL = 'https://www.feliratok.eu';
const REFERER = `${BASE_URL}/index.php`;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

/** Language code mapping: ISO 639-1 → feliratok.eu language IDs */
const LANG_MAP: Record<string, number> = {
  hu: 1,
  en: 2,
};

interface EpisodeSubtitle {
  language: string;
  nev: string;
  fnev: string;
  felirat: number;
  evad: string;
  ep: string;
  feltolto: string;
  evadpakk: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface SupersubtitlesSettings {}

export class SupersubtitlesProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(SupersubtitlesProvider.name);

  constructor(private readonly settings: SupersubtitlesSettings) {}

  private get headers(): Record<string, string> {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    return {
      'User-Agent': ua,
      Referer: REFERER,
    };
  }

  /**
   * Supersubtitles (feliratok.eu) supports Hungarian and English subtitles
   * for both series (episodes) and movies.
   * Based on Bazarr's implementation (subliminal_patch/providers/supersubtitles.py).
   */
  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    if (params.season != null && params.episode != null) {
      return this.searchEpisode(params);
    }
    return this.searchMovie(params);
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    const url = `${BASE_URL}/index.php?action=letolt&felirat=${result.providerFileId}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Supersubtitles download failed: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await fetch(
        `${BASE_URL}/index.php?term=test&nyelv=0&action=autoname`,
        { headers: this.headers },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Series (episode) search
  // ---------------------------------------------------------------------------

  private async searchEpisode(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    // Step 1: Look up the series ID by name
    const seriesId = await this.lookupSeriesId(params.title);
    if (!seriesId) {
      this.logger.debug(
        `Supersubtitles: series not found for "${params.title}"`,
      );
      return [];
    }

    // Step 2: Query subtitles for the specific episode
    const url = `${BASE_URL}/index.php?action=xbmc&sid=${seriesId}&ev=${params.season ?? 1}&rtol=${params.episode ?? 1}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers });
    } catch (e) {
      this.logger.warn(
        `Supersubtitles episode search error: ${(e as Error).message}`,
      );
      return [];
    }

    if (!res.ok) {
      this.logger.warn(`Supersubtitles episode search failed: ${res.status}`);
      return [];
    }

    const body = (await res.json()) as Record<string, EpisodeSubtitle>;

    const results: SubtitleSearchResult[] = [];
    for (const [, item] of Object.entries(body)) {
      if (!item.felirat) continue;

      // Skip season packs
      if (item.evadpakk === '1') continue;

      const lang = this.mapLanguage(item.language);
      // Filter by requested language if specified
      if (params.language && lang !== params.language) continue;

      const label =
        item.fnev || item.nev || `S${item.evad}E${item.ep} - ${params.title}`;
      const forced = (item.nev || '').toLowerCase().includes('forced');

      results.push({
        providerFileId: String(item.felirat),
        title: label,
        language: lang,
        forced,
        hearingImpaired: false,
        score: 50,
        providerName: 'Supersubtitles',
        providerType: 'supersubtitles',
      });
    }

    return results;
  }

  /**
   * Look up a series ID on feliratok.eu using the autoname/autocomplete API.
   */
  private async lookupSeriesId(title: string): Promise<string | null> {
    const url = `${BASE_URL}/index.php?term=${encodeURIComponent(title)}&nyelv=0&action=autoname`;

    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers });
    } catch (e) {
      this.logger.warn(
        `Supersubtitles series lookup error: ${(e as Error).message}`,
      );
      return null;
    }

    if (!res.ok) return null;

    const body = (await res.json()) as { name: string; ID: string }[];
    if (!Array.isArray(body) || !body.length) return null;

    // Try exact match first, then first result
    const normalized = title.toLowerCase().trim();
    const match =
      body.find((s) => s.name.toLowerCase().trim() === normalized) ?? body[0];
    return match?.ID ?? null;
  }

  // ---------------------------------------------------------------------------
  // Movie search
  // ---------------------------------------------------------------------------

  private async searchMovie(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    const url = `${BASE_URL}/index.php?search=${encodeURIComponent(params.title)}&soriSorszam=&nyelv=&tab=film`;

    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers });
    } catch (e) {
      this.logger.warn(
        `Supersubtitles movie search error: ${(e as Error).message}`,
      );
      return [];
    }

    if (!res.ok) {
      this.logger.warn(`Supersubtitles movie search failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    return this.parseMovieResults(html, params.language);
  }

  /**
   * Parse the HTML search results page for movie subtitles.
   * feliratok.eu returns an HTML table with subtitle links.
   */
  private parseMovieResults(
    html: string,
    language?: string,
  ): SubtitleSearchResult[] {
    const results: SubtitleSearchResult[] = [];

    // Match subtitle download links and their surrounding context
    // Pattern: <a href="...action=letolt&felirat=NNNN..." ...>...</a>
    const linkRegex = /action=letolt&(?:amp;)?felirat=(\d+)/g;
    const langRegex = /(?:Magyar|Hungarian|Angol|English)/gi;

    // Split HTML into table rows for context
    const rows = html.split(/<tr[^>]*>/i);

    for (const row of rows) {
      const linkMatch = linkRegex.exec(row);
      linkRegex.lastIndex = 0; // Reset for next row

      if (!linkMatch) continue;

      const subtitleId = linkMatch[1];

      // Detect language from row content
      let lang = 'hu';
      const langMatches = row.match(langRegex);
      if (langMatches) {
        const lastLang = langMatches[langMatches.length - 1].toLowerCase();
        if (lastLang === 'angol' || lastLang === 'english') {
          lang = 'en';
        }
      }

      // Filter by language if specified
      if (language && lang !== language) continue;

      // Extract release name from the row
      const titleMatch = row.match(/title="([^"]+)"/i);
      const label = titleMatch?.[1] || `Movie subtitle #${subtitleId}`;
      const forced =
        row.toLowerCase().includes('forced') || row.includes('szinkronoshoz');

      results.push({
        providerFileId: subtitleId,
        title: this.decodeHtmlEntities(label),
        language: lang,
        forced,
        hearingImpaired: false,
        score: 50,
        providerName: 'Supersubtitles',
        providerType: 'supersubtitles',
      });
    }

    return results;
  }

  private mapLanguage(lang: string): string {
    const l = lang.toLowerCase();
    if (l.includes('magyar') || l.includes('hungarian') || l === 'hu')
      return 'hu';
    if (l.includes('angol') || l.includes('english') || l === 'en') return 'en';
    return l;
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'");
  }
}
