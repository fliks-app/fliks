import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
  SubtitleProviderTestResult,
  testResultFromResponse,
} from './subtitle-provider.interface';
import { isRateLimited, rateLimitedFetch } from './rate-limiter';

const PROVIDER_TYPE = 'supersubtitles';
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
    if (isRateLimited(PROVIDER_TYPE)) return [];

    if (params.season != null && params.episode != null) {
      return this.searchEpisode(params);
    }
    return this.searchMovie(params);
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    if (isRateLimited(PROVIDER_TYPE)) {
      throw new Error('Supersubtitles is rate-limited, try again later');
    }
    const url = `${BASE_URL}/index.php?action=letolt&felirat=${encodeURIComponent(result.providerFileId)}`;
    const res = await rateLimitedFetch(PROVIDER_TYPE, url, {
      headers: this.headers,
    });
    if (!res || !res.ok) {
      throw new Error(`Supersubtitles download failed: ${res?.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(): Promise<SubtitleProviderTestResult> {
    const res = await fetch(
      `${BASE_URL}/index.php?term=test&nyelv=0&action=autoname`,
      { headers: this.headers },
    );
    return testResultFromResponse(res);
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
    const res = await rateLimitedFetch(PROVIDER_TYPE, url, {
      headers: this.headers,
    });
    if (!res) return [];
    if (!res.ok) {
      this.logger.warn(`Supersubtitles episode search failed: ${res.status}`);
      return [];
    }

    // Measured: an episode with nothing answers 200 with an empty body, and a
    // bad series id answers 200 with the plain text "Nincs SorozatID!".
    const body = await this.parseJson<Record<string, EpisodeSubtitle>>(res);
    if (!body || typeof body !== 'object') {
      this.logger.debug(
        `Supersubtitles: no subtitles for "${params.title}" S${params.season ?? 1}E${params.episode ?? 1}`,
      );
      return [];
    }

    const results: SubtitleSearchResult[] = [];
    for (const item of Object.values(body)) {
      if (!item?.felirat) continue;

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
        releaseName: item.fnev || item.nev || undefined,
        language: lang,
        forced,
        hearingImpaired: false,
        score: 0,
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
    const res = await rateLimitedFetch(PROVIDER_TYPE, url, {
      headers: this.headers,
    });
    if (!res || !res.ok) return null;

    const body = await this.parseJson<{ name: string; ID: string }[]>(res);
    if (!Array.isArray(body) || !body.length) return null;

    // Try exact match first, then first result. The autocomplete never answers
    // empty: a miss comes back as one row carrying a non-numeric sentinel id.
    const normalized = title.toLowerCase().trim();
    const match =
      body.find((s) => s?.name?.toLowerCase().trim() === normalized) ?? body[0];
    const id = match?.ID;
    return id && /^\d+$/.test(id) ? id : null;
  }

  /** The API answers 200 with an empty body, or with a plain-text message, for
   *  cases it has no data for, so `res.json()` would throw on both. */
  private async parseJson<T>(res: Response): Promise<T | null> {
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.debug(
        `Supersubtitles answered no JSON: ${text.slice(0, 80)}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Movie search
  // ---------------------------------------------------------------------------

  private async searchMovie(
    params: SubtitleSearchParams,
  ): Promise<SubtitleSearchResult[]> {
    const url = `${BASE_URL}/index.php?search=${encodeURIComponent(params.title)}&soriSorszam=&nyelv=&tab=film`;
    const res = await rateLimitedFetch(PROVIDER_TYPE, url, {
      headers: this.headers,
    });
    if (!res) return [];
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

    // The id is the last parameter of the download link, after the filename:
    // /index.php?action=letolt&fnev=Name.en.srt&felirat=1756650761
    const linkRegex = /action=letolt[^"']*?[&?](?:amp;)?felirat=(\d+)/;
    // The row carries its language in a cell of its own. Scanning the whole row
    // instead reads the CSS class on the Hungarian-title div as a language.
    const langCellRegex = /class="lang"[^>]*>\s*<small>([^<]+)<\/small>/i;
    const releaseRegex = /class="eredeti"[^>]*>([^<]*)</i;

    // Split HTML into table rows for context
    const rows = html.split(/<tr[^>]*>/i);

    for (const row of rows) {
      const linkMatch = linkRegex.exec(row);
      if (!linkMatch) continue;

      const subtitleId = linkMatch[1];
      const langCell = row.match(langCellRegex)?.[1];
      const lang = langCell ? this.mapLanguage(langCell.trim()) : 'hu';

      // Filter by language if specified
      if (language && lang !== language) continue;

      const release = row.match(releaseRegex)?.[1]?.trim();
      const label = release || `Movie subtitle #${subtitleId}`;
      const forced =
        row.toLowerCase().includes('forced') || row.includes('szinkronoshoz');

      const decodedLabel = this.decodeHtmlEntities(label);
      results.push({
        providerFileId: subtitleId,
        title: decodedLabel,
        releaseName: decodedLabel,
        language: lang,
        forced,
        hearingImpaired: false,
        score: 0,
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
