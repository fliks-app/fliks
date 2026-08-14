import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { ReleasePickerPair, ReleasePickerRoutes } from '@fliks/plugin-contract/ui';

export interface MovieRelease {
  title: string;
  downloadUrl: string;
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  sourceId: number;
  sourceName: string;
  languageId: number;
  languageName: string;
  languageAllowed: boolean;
  size: number;
  seeders: number;
  leechers: number;
  rejections: { code: string; params?: Record<string, number | string> }[];
  freeleech: boolean;
  downloadVolumeFactor: number;
  isFullSeason: boolean;
  sizeDeviation: number | null;
  videoCodec: 'AV1' | 'HEVC' | 'VP9' | 'x264' | null;
}

interface GrabBody {
  downloadUrl?: string;
  sourceTitle?: string;
  sourceId?: number;
  /** Manual override for a release the profile would otherwise reject — never sent for an allowed grab. */
  force?: boolean;
}

interface RouteParams {
  id: number;
  seasonId?: number;
  episodeId?: number;
}

/** Substitutes `:id`/`:seasonId`/`:episodeId` and prefixes the plugin's proxy path.
 *  Null (never a request) when a placeholder the params don't cover survives. */
export function resolveReleasePickerUrl(pluginId: string, route: string, params: RouteParams): string | null {
  let path = route.replace(':id', String(params.id));
  if (params.seasonId != null) path = path.replace(':seasonId', String(params.seasonId));
  if (params.episodeId != null) path = path.replace(':episodeId', String(params.episodeId));
  return /:[A-Za-z]/.test(path) ? null : `/api/plugins/${pluginId}${path}`;
}

/** Calls the release picker's `search`/`grab` routes, declared by whichever plugin
 *  contributes `ui.releasePicker` and reached through its proxy. */
@Injectable({ providedIn: 'root' })
export class MediaDetailReleasePickerService {
  private readonly http = inject(HttpClient);
  private readonly registry = inject(PluginUiRegistryService);

  getMovieReleases(id: number, q?: string): Promise<MovieRelease[]> {
    return this.search((r) => r.movie, { id }, q);
  }

  grabMovie(id: number, body: GrabBody = {}): Promise<void> {
    return this.grab((r) => r.movie, { id }, body);
  }

  getSeasonReleases(mediaId: number, seasonId: number, q?: string): Promise<MovieRelease[]> {
    return this.search((r) => r.season, { id: mediaId, seasonId }, q);
  }

  grabSeason(mediaId: number, seasonId: number, body: GrabBody = {}): Promise<void> {
    return this.grab((r) => r.season, { id: mediaId, seasonId }, body);
  }

  getEpisodeReleases(mediaId: number, episodeId: number, q?: string): Promise<MovieRelease[]> {
    return this.search((r) => r.episode, { id: mediaId, episodeId }, q);
  }

  grabEpisode(mediaId: number, episodeId: number, body: GrabBody = {}): Promise<void> {
    return this.grab((r) => r.episode, { id: mediaId, episodeId }, body);
  }

  private async search(
    pick: (r: ReleasePickerRoutes) => ReleasePickerPair,
    params: RouteParams,
    q?: string,
  ): Promise<MovieRelease[]> {
    const url = this.resolve(pick, 'search', params);
    const httpParams: Record<string, string> = {};
    if (q?.trim()) httpParams['q'] = q.trim();
    return firstValueFrom(this.http.get<MovieRelease[]>(url, { params: httpParams }));
  }

  private async grab(pick: (r: ReleasePickerRoutes) => ReleasePickerPair, params: RouteParams, body: GrabBody): Promise<void> {
    const url = this.resolve(pick, 'grab', params);
    return firstValueFrom(this.http.post<void>(url, body));
  }

  /** Throws rather than firing a malformed request — unreachable in practice, since
   *  every caller is itself a plugin contribution that disappears with the plugin. */
  private resolve(
    pick: (r: ReleasePickerRoutes) => ReleasePickerPair,
    which: keyof ReleasePickerPair,
    params: RouteParams,
  ): string {
    const picker = this.registry.releasePicker();
    const url = picker && resolveReleasePickerUrl(picker.pluginId, pick(picker.routes)[which], params);
    if (!url) throw new Error('release picker route unavailable');
    return url;
  }
}
