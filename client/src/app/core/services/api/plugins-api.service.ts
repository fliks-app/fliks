import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { FieldDef } from '../../plugin-ui/contribution.types';

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

/** One tracker a `data` plugin declares, exposed under its namespaced implementation id. */
export interface IndexerDescriptorRow {
  implementationId: string;
  pluginId: string;
  key: string;
  name: string;
  driverApi: string;
  endpoint: string;
  settings: FieldDef[];
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

  /** Every indexer descriptor currently on offer, for the "add indexer" type selector. */
  getIndexerDescriptors() {
    return firstValueFrom(
      this.http.get<IndexerDescriptorRow[]>('/api/plugins/indexer-descriptors'),
    );
  }

  /** `<img src>` only — never fetched and inlined as trusted markup (the route is `sandbox`-CSP'd SVG/PNG bytes). */
  logoUrl(pluginId: string): string {
    return `/api/plugins/${pluginId}/logo`;
  }
}
