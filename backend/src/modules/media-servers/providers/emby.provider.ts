import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { MediaServerProvider } from './media-server-provider.interface';

export interface EmbyUser {
  Id: string;
  Name: string;
}

export interface EmbyItem {
  Id: string;
  Type: 'Movie' | 'Episode';
  Name: string;
  SeriesName?: string;
  /** Season number (for episodes). */
  ParentIndexNumber?: number;
  /** Episode number (for episodes). */
  IndexNumber?: number;
  ProviderIds?: { Tmdb?: string; Imdb?: string; Tvdb?: string };
  /** ISO timestamp — present for series episodes only (points to the parent series). */
  SeriesId?: string;
  UserData?: {
    Played: boolean;
    LastPlayedDate?: string;
    /** 1 tick = 100 ns */
    PlaybackPositionTicks?: number;
    PlayCount?: number;
  };
  /** Date the item was added to the Emby library (ISO timestamp). */
  DateCreated?: string;
  /** ISO timestamp of last metadata refresh. */
  PremiereDate?: string;
  /** 1 tick = 100 ns */
  RunTimeTicks?: number;
}

@Injectable()
export class EmbyProvider implements MediaServerProvider {
  private readonly log = new Logger(EmbyProvider.name);

  readonly type = 'emby';
  readonly label = 'Emby';
  readonly supportedEvents = [
    'download.complete',
    'subtitle.downloaded',
    'subtitle.upgraded',
    'subtitle.synced',
    'file.deleted',
    'media.deleted',
    'library.rescan',
  ];

  async refreshLibrary(url: string, apiKey: string): Promise<void> {
    const base = url.replace(/\/$/, '');
    await axios.post(`${base}/Library/Refresh`, null, {
      headers: { 'X-Emby-Token': apiKey },
      timeout: 30_000,
    });
    this.log.log(`Emby library refresh triggered on ${base}`);
  }

  async testConnection(
    url: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }> {
    const base = url.replace(/\/$/, '');
    try {
      const res = await axios.get<{ ServerName?: string }>(
        `${base}/System/Info`,
        {
          headers: { 'X-Emby-Token': apiKey },
          timeout: 15_000,
        },
      );
      const name = res.data?.ServerName ?? 'Emby';
      return { ok: true, message: `Connecte a ${name}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** List every Emby user. Used for watch-history import to map by username. */
  async listUsers(url: string, apiKey: string): Promise<EmbyUser[]> {
    const base = url.replace(/\/$/, '');
    const res = await axios.get<EmbyUser[]>(`${base}/Users`, {
      headers: { 'X-Emby-Token': apiKey },
      timeout: 30_000,
    });
    return res.data ?? [];
  }

  /**
   * Paginated fetch of every movie/episode the given Emby user has played.
   * Includes provider IDs + user data (last-played, position) + runtime.
   */
  async getWatchedItems(
    url: string,
    apiKey: string,
    embyUserId: string,
    offset = 0,
    limit = 500,
  ): Promise<{ items: EmbyItem[]; total: number }> {
    const base = url.replace(/\/$/, '');
    const res = await axios.get<{
      Items: EmbyItem[];
      TotalRecordCount: number;
    }>(`${base}/Users/${embyUserId}/Items`, {
      headers: { 'X-Emby-Token': apiKey },
      params: {
        IsPlayed: 'true',
        IncludeItemTypes: 'Movie,Episode',
        Fields:
          'ProviderIds,UserData,ParentIndexNumber,IndexNumber,SeriesName,SeriesId,RunTimeTicks,DateCreated,PremiereDate',
        Recursive: 'true',
        StartIndex: offset,
        Limit: limit,
      },
      timeout: 60_000,
    });
    return {
      items: res.data?.Items ?? [],
      total: res.data?.TotalRecordCount ?? 0,
    };
  }

  /**
   * Resolve the ProviderIds of a single series by its Emby ID. Used when an
   * episode returned by `getWatchedItems` carries no `ProviderIds.Tmdb` on
   * the episode itself (Emby puts the TMDB on the series only — common case).
   */
  async getItem(
    url: string,
    apiKey: string,
    embyUserId: string,
    itemId: string,
  ): Promise<EmbyItem | null> {
    const base = url.replace(/\/$/, '');
    try {
      const res = await axios.get<EmbyItem>(
        `${base}/Users/${embyUserId}/Items/${itemId}`,
        {
          headers: { 'X-Emby-Token': apiKey },
          timeout: 30_000,
        },
      );
      return res.data ?? null;
    } catch {
      return null;
    }
  }
}
