import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { ReleasePickerPair } from '@fliks/plugin-ui';
import type { AcquisitionProvider } from '../../core/plugin-ui/plugin-ui-response';
import type { AcquisitionTarget } from '../../core/acquisition/acquisition';

export interface MovieRelease {
  title: string;
  downloadUrl: string;
  /** The tracker's own page for this release, when the feed named one. Distinct from
   *  `downloadUrl`, which is the indexer's API endpoint and carries its key. */
  infoUrl?: string;
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  /** The provider that found it; a grab goes back to it. */
  pluginId?: string;
  sourceId: number | string;
  sourceName: string;
  languages: { id: number; name: string }[];
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

export interface GrabBody {
  downloadUrl?: string;
  sourceTitle?: string;
  sourceId?: number | string;
  /** Manual override for a release the profile would otherwise reject — never sent for an allowed grab. */
  force?: boolean;
  /** Echoed back from the search hit: the plugin cannot recover it from `downloadUrl`. */
  infoUrl?: string;
}

/** Substitutes `:id`/`:groupId`/`:itemId` and prefixes the plugin's proxy path.
 *  Null (never a request) when a placeholder the target doesn't cover survives. */
export function resolveReleasePickerUrl(pluginId: string, route: string, t: AcquisitionTarget): string | null {
  let path = route.replace(':id', String(t.mediaId));
  if (t.groupId != null) path = path.replace(':groupId', String(t.groupId));
  if (t.itemId != null) path = path.replace(':itemId', String(t.itemId));
  return /:[A-Za-z]/.test(path) ? null : `/api/plugins/${pluginId}${path}`;
}

/** Calls the `search`/`grab` routes of an acquisition provider, declared by its `ui.releasePicker` and reached through its proxy. */
@Injectable({ providedIn: 'root' })
export class MediaDetailReleasePickerService {
  private readonly http = inject(HttpClient);
  private readonly registry = inject(PluginUiRegistryService);

  /** Providers able to search this target, in the admin order. */
  providersFor(target: Pick<AcquisitionTarget, 'kind' | 'level'>): AcquisitionProvider[] {
    return this.registry.providersFor(target.kind, target.level);
  }

  /** `searchId` names the waiting modal, echoed on every partial result so a modal ignores other searches; omitted means answer only, nothing streamed. */
  async search(pluginId: string, target: AcquisitionTarget, q?: string, searchId?: string): Promise<MovieRelease[]> {
    const url = this.resolve(pluginId, target, 'search');
    const params: Record<string, string> = { family: target.family };
    if (target.language) params['language'] = target.language;
    if (q?.trim()) params['q'] = q.trim();
    if (searchId) params['sid'] = searchId;
    return firstValueFrom(this.http.get<MovieRelease[]>(url, { params }));
  }

  async grab(pluginId: string, target: AcquisitionTarget, body: GrabBody = {}): Promise<void> {
    const url = this.resolve(pluginId, target, 'grab');
    return firstValueFrom(this.http.post<void>(url, { family: target.family, language: target.language ?? null, ...body }));
  }

  /** The core's search across every provider and grab of the best release (`POST /api/media/:id/grab-best`). */
  async grabBest(target: AcquisitionTarget): Promise<void> {
    const { groupId, itemId, family, language } = target;
    const body = { groupId, itemId, family, language: language ?? null };
    return firstValueFrom(this.http.post<void>(`/api/media/${target.mediaId}/grab-best`, body));
  }

  /** Throws rather than firing a malformed request: every caller picked the provider from `providersFor`. */
  private resolve(pluginId: string, target: AcquisitionTarget, which: keyof ReleasePickerPair): string {
    const pair = this.providersFor(target).find((p) => p.pluginId === pluginId)?.routes.byKind[target.kind]?.[target.level];
    const url = pair && resolveReleasePickerUrl(pluginId, pair[which], target);
    if (!url) throw new Error('release picker route unavailable');
    return url;
  }
}
