import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type PluginKind = 'data' | 'process';
/** Mirrors backend `TrustOutcome` (`archive/trust-store.ts`). */
export type PluginTrust = 'official' | `verified-${string}` | 'unverified' | 'unsigned';
export type PluginOrigin = 'catalog' | 'manual';
export type PluginStatus = 'active' | 'failed';

export interface PluginSummary {
  pluginId: string;
  name: string;
  version: string;
  kind: PluginKind;
  origin: PluginOrigin;
  status: PluginStatus;
  statusReason: string | null;
  signature: PluginTrust;
  verifiedByKeyId: string | null;
}

/** Mirrors backend `PluginInspectReport`. A refusal carries `refusalCode`/`detail` and nothing else. */
export interface PluginInspectReport {
  installable: boolean;
  refusalCode?: string;
  detail?: string;
  stagingId?: string;
  sha256?: string;
  id?: string;
  name?: string;
  version?: string;
  kind?: PluginKind;
  signature?: PluginTrust;
  signedByKeyId?: string;
  capabilities?: string[];
  compatible?: boolean;
}

export interface PluginInstallResult {
  pluginId: string;
  version: string;
  status: PluginStatus;
  reason?: string;
  detail?: string;
}

/** Mirrors backend `PluginSourceSummary` (`plugin-sources.controller.ts`) — never the raw `publicKey` bytes. */
export interface PluginSourceRow {
  id: number;
  url: string;
  enabled: boolean;
  hasPinnedKey: boolean;
  lastRefreshedAt: string | null;
  lastRefreshError: string | null;
  pluginCount: number;
}

export type CatalogRefreshResult = { ok: true } | { ok: false; reason: string; detail: string };

/** Mirrors backend `CatalogVersionEntry` (`catalog/catalog.ts`) — `zipUrl`/`sha256` pass through unread. */
export interface CatalogVersionEntry {
  version: string;
  pluginApi: number;
  fliks: string;
  [key: string]: unknown;
}

export interface CatalogHiddenSummary {
  count: number;
  minFliksVersion: string | null;
}

/** Mirrors backend `FilteredCatalogEntry`. */
export interface CatalogPluginEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  kind: PluginKind;
  logo?: string;
  installable: CatalogVersionEntry[];
  hidden: CatalogHiddenSummary | null;
}

export interface PluginSourceCatalog {
  cachedCatalog: { plugins: CatalogPluginEntry[] } | null;
  lastRefreshedAt: string | null;
  lastRefreshError: string | null;
}

@Injectable({ providedIn: 'root' })
export class PluginsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<PluginSummary[]>('/api/plugins'));
  }

  inspect(file: File) {
    const form = new FormData();
    form.append('file', file);
    return firstValueFrom(
      this.http.post<PluginInspectReport>('/api/plugins/import/inspect', form),
    );
  }

  confirm(stagingId: string, sha256: string) {
    return firstValueFrom(
      this.http.post<PluginInstallResult>('/api/plugins/import/confirm', { stagingId, sha256 }),
    );
  }

  uninstall(pluginId: string) {
    return firstValueFrom(this.http.delete<void>(`/api/plugins/${pluginId}`));
  }

  listSources() {
    return firstValueFrom(this.http.get<PluginSourceRow[]>('/api/plugins/sources'));
  }

  createSource(dto: { url: string; publicKey?: string; enabled?: boolean }) {
    return firstValueFrom(this.http.post<PluginSourceRow>('/api/plugins/sources', dto));
  }

  updateSource(id: number, dto: { url?: string; publicKey?: string | null; enabled?: boolean }) {
    return firstValueFrom(this.http.put<PluginSourceRow>(`/api/plugins/sources/${id}`, dto));
  }

  deleteSource(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/plugins/sources/${id}`));
  }

  refreshSource(id: number) {
    return firstValueFrom(this.http.post<CatalogRefreshResult>(`/api/plugins/sources/${id}/refresh`, {}));
  }

  getSourceCatalog(id: number) {
    return firstValueFrom(this.http.get<PluginSourceCatalog>(`/api/plugins/sources/${id}/catalog`));
  }

  inspectFromCatalog(sourceId: number, pluginId: string, version: string) {
    return firstValueFrom(
      this.http.post<PluginInspectReport>(`/api/plugins/sources/${sourceId}/inspect`, { pluginId, version }),
    );
  }

  /** `<img src>` only — never fetched and inlined as trusted markup (the route is `sandbox`-CSP'd SVG/PNG bytes). */
  logoUrl(pluginId: string): string {
    return `/api/plugins/${pluginId}/logo`;
  }
}
