import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface SeerrUser {
  id: number;
  email?: string;
  displayName?: string;
  jellyfinUsername?: string;
  plexUsername?: string;
  /** Local Seerr account name (when not linked to Jellyfin/Plex). */
  username?: string;
}

/** Seerr request status codes. */
export const SEERR_REQUEST_STATUS = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
} as const;

/** Seerr media availability status codes. */
export const SEERR_MEDIA_STATUS = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
} as const;

export interface SeerrMediaRequest {
  id: number;
  status: 1 | 2 | 3 | 4;
  type: 'movie' | 'tv';
  createdAt: string;
  updatedAt: string;
  is4k?: boolean;
  media: {
    id: number;
    tmdbId: number;
    /** 1=UNKNOWN 2=PENDING 3=PROCESSING 4=PARTIALLY_AVAILABLE 5=AVAILABLE */
    status: 1 | 2 | 3 | 4 | 5;
    /** Some Seerr builds expose the title here, others don't. */
    title?: string;
    name?: string;
  };
  requestedBy: SeerrUser;
  seasons?: { seasonNumber: number }[];
}

/**
 * Thin client for Seerr's REST API (compatible with both Jellyseerr and
 * Overseerr — same endpoints / auth scheme since Jellyseerr is a fork).
 *
 * Auth: send the admin API key in the `X-Api-Key` header.
 */
@Injectable()
export class SeerrService {
  private readonly log = new Logger(SeerrService.name);

  /**
   * Verify connectivity + API key by hitting `/api/v1/settings/main`. Any 2xx
   * response means the key is admin-grade (this endpoint is admin-only).
   */
  async testConnection(
    url: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }> {
    const base = this.normalize(url);
    try {
      const res = await axios.get<{ applicationTitle?: string }>(
        `${base}/api/v1/settings/main`,
        {
          headers: { 'X-Api-Key': apiKey },
          timeout: 15_000,
        },
      );
      const name = res.data?.applicationTitle ?? 'Seerr';
      return { ok: true, message: `Connecté à ${name}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * Resolve a movie/tv title via Seerr's TMDB proxy. The `/request`
   * endpoint only returns IDs, not titles — Seerr fetches them from
   * TMDB at display time. We use the same proxy for orphan requests where
   * the matching Fliks `Media` row doesn't exist yet.
   *
   * Returns `null` on any error (404, network) so the caller can fall back
   * to a placeholder without blowing up the whole import.
   */
  async fetchTitle(
    url: string,
    apiKey: string,
    type: 'movie' | 'tv',
    tmdbId: number,
  ): Promise<string | null> {
    const base = this.normalize(url);
    try {
      const res = await axios.get<{ title?: string; name?: string }>(
        `${base}/api/v1/${type}/${tmdbId}`,
        {
          headers: { 'X-Api-Key': apiKey },
          timeout: 15_000,
        },
      );
      const t = type === 'movie' ? res.data?.title : res.data?.name;
      return t?.trim() || null;
    } catch (e) {
      this.log.warn(
        `fetchTitle(${type}, ${tmdbId}) failed: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Paginated list of every request (filter=all, sort=added). Caller should
   * keep paging until `results.length === 0` or `skip >= total`.
   */
  async listRequests(
    url: string,
    apiKey: string,
    skip: number,
    take: number,
  ): Promise<{ total: number; results: SeerrMediaRequest[] }> {
    const base = this.normalize(url);
    const res = await axios.get<{
      pageInfo?: { results: number };
      results: SeerrMediaRequest[];
    }>(`${base}/api/v1/request`, {
      headers: { 'X-Api-Key': apiKey },
      params: { take, skip, filter: 'all', sort: 'added' },
      timeout: 60_000,
    });
    return {
      total: res.data?.pageInfo?.results ?? 0,
      results: res.data?.results ?? [],
    };
  }

  private normalize(url: string): string {
    return url.replace(/\/$/, '');
  }
}
