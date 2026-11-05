import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { ReleasePickerPair } from '@fliks/plugin-ui';
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
  sourceId: number;
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
  sourceId?: number;
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

/** Calls the release picker's `search`/`grab` routes, declared by whichever plugin
 *  contributes `ui.releasePicker` and reached through its proxy. */
@Injectable({ providedIn: 'root' })
export class MediaDetailReleasePickerService {
  private readonly http = inject(HttpClient);
  private readonly registry = inject(PluginUiRegistryService);

  /** `searchId` names the waiting modal, echoed on every partial result so a modal ignores other searches; omitted means answer only, nothing streamed. */
  async search(target: AcquisitionTarget, q?: string, searchId?: string): Promise<MovieRelease[]> {
    const url = this.resolve(target, 'search');
    const params: Record<string, string> = { family: target.family };
    if (target.language) params['language'] = target.language;
    if (q?.trim()) params['q'] = q.trim();
    if (searchId) params['sid'] = searchId;
    return firstValueFrom(this.http.get<MovieRelease[]>(url, { params }));
  }

  async grab(target: AcquisitionTarget, body: GrabBody = {}): Promise<void> {
    const url = this.resolve(target, 'grab');
    return firstValueFrom(this.http.post<void>(url, { family: target.family, language: target.language ?? null, ...body }));
  }

  private pair(target: Pick<AcquisitionTarget, 'kind' | 'level'>): ReleasePickerPair | undefined {
    return this.registry.releasePicker()?.routes.byKind[target.kind]?.[target.level];
  }

  /** Throws rather than firing a malformed request — unreachable in practice, since
   *  every caller is itself a plugin contribution that disappears with the plugin. */
  private resolve(target: AcquisitionTarget, which: keyof ReleasePickerPair): string {
    const pair = this.pair(target);
    const pluginId = this.registry.releasePicker()?.pluginId;
    const url = pair && pluginId && resolveReleasePickerUrl(pluginId, pair[which], target);
    if (!url) throw new Error('release picker route unavailable');
    return url;
  }
}
