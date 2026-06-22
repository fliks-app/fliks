import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';
import { extractSubtitleFromZip } from './zip-utils';
import { isRateLimited, rateLimitedFetch } from './rate-limiter';

const PROVIDER_TYPE = 'yify';
const BASE_URL = 'https://yifysubtitles.ch';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Map ISO 639‑1 codes → display names used by yifysubtitles.ch
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

export class YifyProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(YifyProvider.name);

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    if (isRateLimited(PROVIDER_TYPE)) return [];

    // YIFY only supports movies, searched by IMDB ID
    if (!params.imdbId) return [];
    if (params.season != null) return [];

    const url = `${BASE_URL}/movie-imdb/${params.imdbId}`;
    const res = await rateLimitedFetch(PROVIDER_TYPE, url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
    });
    if (!res) return [];
    // 3xx or 404 = movie not found
    if (res.status >= 300) return [];
    if (!res.ok) {
      this.logger.warn(`YIFY search failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const targetLang = LANG_MAP[params.language]?.toLowerCase();

    return this.parseResults(html, targetLang, params.language);
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    if (isRateLimited(PROVIDER_TYPE)) {
      throw new Error('YIFY is rate-limited, try again later');
    }
    // providerFileId stores the subtitle page path (e.g. /subtitles/...)
    const pageUrl = `${BASE_URL}${result.providerFileId}`;
    const pageRes = await rateLimitedFetch(PROVIDER_TYPE, pageUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!pageRes || !pageRes.ok)
      throw new Error(`YIFY subtitle page failed: ${pageRes?.status}`);

    const pageHtml = await pageRes.text();
    const dlMatch = pageHtml.match(
      /class="download-subtitle"[^>]*href="([^"]+)"/,
    );
    if (!dlMatch)
      throw new Error('YIFY: download link not found on subtitle page');

    const dlUrl = `${BASE_URL}${dlMatch[1]}`;
    const dlRes = await rateLimitedFetch(PROVIDER_TYPE, dlUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!dlRes || !dlRes.ok)
      throw new Error(`YIFY download failed: ${dlRes?.status}`);

    const zipBuf = Buffer.from(await dlRes.arrayBuffer());

    // The response is a ZIP containing one or more .srt files
    return extractSubtitleFromZip(zipBuf);
  }

  async testConnection(): Promise<boolean> {
    const res = await fetch(`${BASE_URL}/movie-imdb/tt0111161`, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
    });
    return res.ok;
  }

  /**
   * Parse the HTML table from yifysubtitles.ch movie page.
   *
   * Real HTML structure per row:
   * ```
   * <tr data-id="357699">
   *   <td class="rating-cell"><span class="label label-success">1</span></td>
   *   <td class="flag-cell"><span class="sub-lang">Albanian</span></td>
   *   <td><a href="/subtitles/..."><span class="text-muted">subtitle</span> Release.Name</a></td>
   *   <td class="other-cell"><!-- <span class="hi-subtitle"> if HI --></td>
   *   <td class="uploader-cell">...</td>
   * </tr>
   * ```
   */
  private parseResults(
    html: string,
    targetLang: string | undefined,
    isoCode: string,
  ): SubtitleSearchResult[] {
    const results: SubtitleSearchResult[] = [];

    const tbodyMatch = html.match(
      /<table[^>]*class="[^"]*other-subs[^"]*"[^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i,
    );
    if (!tbodyMatch) return [];

    const tbody = tbodyMatch[1];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tbody)) !== null) {
      const row = rowMatch[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
        (m) => m[1],
      );
      if (cells.length < 5) continue;

      // Cell 0: rating — inside <span class="label">N</span>
      const ratingMatch = cells[0].match(/>(\d+)</);
      const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : 0;

      // Cell 1: language — inside <span class="sub-lang">Language</span>
      const langMatch = cells[1].match(
        /class="sub-lang"[^>]*>([\s\S]*?)<\/span>/i,
      );
      const language = langMatch
        ? this.stripTags(langMatch[1]).trim().toLowerCase()
        : '';

      if (targetLang && language !== targetLang) continue;

      // Cell 2: link href + release name (text after <span>subtitle</span>)
      const hrefMatch = cells[2].match(/href="([^"]+)"/);
      if (!hrefMatch) continue;
      const pagePath = hrefMatch[1].trim();

      // Extract full text inside <a>, then strip inner tags to get release name
      const anchorTextMatch = cells[2].match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      const rawText = anchorTextMatch ? this.stripTags(anchorTextMatch[1]) : '';
      const releaseName = rawText.replace(/^\s*subtitle\s*/i, '').trim();
      if (!releaseName) continue;

      // Cell 3: hearing impaired
      const hearingImpaired = /hi-subtitle/i.test(cells[3]);

      results.push({
        providerFileId: pagePath,
        title: releaseName,
        releaseName,
        language: isoCode,
        forced: false,
        hearingImpaired,
        score: 0,
        providerName: 'YIFY',
        providerType: 'yify',
      });
    }

    return results;
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
  }
}
