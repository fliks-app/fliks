import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
  SubtitleProviderTestResult,
  testResultFromResponse,
} from './subtitle-provider.interface';
import {
  isRateLimited,
  rateLimitedFetch,
  markRateLimited,
} from './rate-limiter';

const PROVIDER_TYPE = 'opensubtitles';
const DEFAULT_API_KEY = 'KXXhBJcOUG9xTxmPzIIkE56obyHtyCyd';
const USER_AGENT = 'Fliks v1.0';

interface OpenSubtitlesSettings {
  apiKey?: string;
  username: string;
  password: string;
}

/** The factory builds a provider per call, so an instance field meant a login
 *  before every search and every download. Tokens last ~24h; keyed by the
 *  credentials that obtained them. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

export class OpenSubtitlesProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(OpenSubtitlesProvider.name);

  constructor(private readonly settings: OpenSubtitlesSettings) {}

  private get tokenKey(): string {
    return `${this.apiKey}:${this.settings.username}`;
  }

  private get token(): string | null {
    const hit = tokenCache.get(this.tokenKey);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      tokenCache.delete(this.tokenKey);
      return null;
    }
    return hit.token;
  }

  private get apiKey(): string {
    return this.settings.apiKey?.trim() || DEFAULT_API_KEY;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    if (isRateLimited(PROVIDER_TYPE)) return [];

    await this.ensureToken();

    const query = new URLSearchParams();
    if (params.moviehash) query.set('moviehash', params.moviehash);
    if (params.imdbId) query.set('imdb_id', params.imdbId);
    if (params.tmdbId) query.set('tmdb_id', String(params.tmdbId));
    if (!params.moviehash && !params.imdbId && !params.tmdbId) {
      query.set('query', params.title);
      if (params.year) query.set('year', String(params.year));
    }
    query.set('languages', params.language);
    if (params.season != null)
      query.set('season_number', String(params.season));
    if (params.episode != null)
      query.set('episode_number', String(params.episode));

    const res = await rateLimitedFetch(
      PROVIDER_TYPE,
      `https://api.opensubtitles.com/api/v1/subtitles?${query}`,
      { headers: this.headers },
      { defaultBackoffSec: 5 },
    );

    if (!res) return [];

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`OpenSubtitles search failed: ${res.status} ${body}`);
      return [];
    }

    const body = (await res.json()) as {
      data: {
        id: string;
        attributes: {
          release: string;
          language: string;
          hearing_impaired: boolean;
          foreign_parts_only: boolean;
          download_count: number;
          ratings: number;
          moviehash_match: boolean;
          files: { file_id: number }[];
          feature_details?: { imdb_id?: number };
        };
      }[];
    };

    return body.data.map((item) => {
      const imdbRaw = item.attributes.feature_details?.imdb_id;
      return {
        providerFileId: String(item.attributes.files[0]?.file_id ?? item.id),
        title: item.attributes.release,
        releaseName: item.attributes.release,
        imdbId: imdbRaw != null ? String(imdbRaw) : undefined,
        hashMatched: item.attributes.moviehash_match,
        language: item.attributes.language,
        forced: item.attributes.foreign_parts_only,
        hearingImpaired: item.attributes.hearing_impaired,
        score: 0,
        downloadCount: item.attributes.download_count,
        providerName: 'OpenSubtitles',
        providerType: PROVIDER_TYPE,
      };
    });
  }

  async download(result: SubtitleSearchResult): Promise<Buffer> {
    if (isRateLimited(PROVIDER_TYPE)) {
      throw new Error('OpenSubtitles is rate-limited, try again later');
    }

    await this.ensureToken();

    const res = await rateLimitedFetch(
      PROVIDER_TYPE,
      'https://api.opensubtitles.com/api/v1/download',
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ file_id: Number(result.providerFileId) }),
      },
      { defaultBackoffSec: 60 },
    );

    if (!res || !res.ok) {
      const body = res ? await res.text().catch(() => '') : 'rate-limited';
      throw new Error(`OpenSubtitles download failed: ${body}`);
    }

    const body = (await res.json()) as { link: string; remaining: number };

    // Track remaining downloads quota
    if (body.remaining != null && body.remaining <= 0) {
      this.logger.warn(`OpenSubtitles download quota exhausted`);
      markRateLimited(PROVIDER_TYPE, null, 3600); // 1h backoff when quota 0
    }

    // Their CDN hosts can't be enumerated safely, so no allowlist — but the
    // scheme is ours to insist on, and the host is worth a log line.
    const link = new URL(body.link);
    if (link.protocol !== 'https:') {
      throw new Error(`OpenSubtitles returned a non-https link (${link.protocol})`);
    }
    const fileRes = await fetch(link, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!fileRes.ok)
      throw new Error(`Failed to fetch subtitle file: ${fileRes.status}`);
    return Buffer.from(await fileRes.arrayBuffer());
  }

  async testConnection(
    settings: Record<string, unknown>,
  ): Promise<SubtitleProviderTestResult> {
    const apiKey = (settings.apiKey as string)?.trim() || this.apiKey;
    const username = (settings.username as string) || this.settings.username;
    const password = (settings.password as string) || this.settings.password;

    if (!username || !password)
      return { ok: false, detail: 'missing username or password' };

    const res = await fetch('https://api.opensubtitles.com/api/v1/login', {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ username, password }),
    });

    return testResultFromResponse(res);
  }

  private async ensureToken(): Promise<void> {
    if (this.token) return;
    if (!this.settings.username || !this.settings.password) return;
    if (isRateLimited(PROVIDER_TYPE)) return;

    const res = await rateLimitedFetch(
      PROVIDER_TYPE,
      'https://api.opensubtitles.com/api/v1/login',
      {
        method: 'POST',
        headers: {
          'Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          username: this.settings.username,
          password: this.settings.password,
        }),
      },
      { defaultBackoffSec: 60 },
    );

    if (!res) return;

    if (res.ok) {
      const body = (await res.json()) as { token: string };
      tokenCache.set(this.tokenKey, {
        token: body.token,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      });
      this.logger.log('OpenSubtitles: authenticated successfully');
    } else {
      const body = await res.text().catch(() => '');
      this.logger.warn(`OpenSubtitles login failed: ${res.status} ${body}`);
    }
  }
}
