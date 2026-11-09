import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { saveFile } from '../../../core/plugins/save-file.plugin';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { CardAction } from '../../../core/services/card-actions.service';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import {
  CatalogueRow,
  PluginsApiService,
  PluginSummary,
  PluginInspectReport,
  PluginInstallResult,
  PluginMetricsEntry,
} from '../../../core/services/api/plugins-api.service';
import { compareVersions } from '../../../core/utils/semver';
import { statusBadgeFor } from './plugin-status';

/** A plugin as the pages show it: installed, offered by a catalog, or both. */
export interface PluginEntry {
  id: string;
  name: string;
  installed: PluginSummary | null;
  catalog: CatalogueRow | null;
  /** The catalog's newest version when it is above the installed one. */
  updateTo: string | null;
  logo: string | null;
}

const CATEGORIES = ['metadata', 'download', 'notifications', 'other'] as const;
export type PluginCategory = (typeof CATEGORIES)[number];

/** The catalog's category, else what the plugin may do tells it. */
export function categoryOf(entry: PluginEntry): PluginCategory {
  const declared = entry.catalog?.plugin.category;
  if (CATEGORIES.includes(declared as PluginCategory)) return declared as PluginCategory;
  const caps = entry.installed?.capabilities ?? [];
  if (caps.includes('scope:ingest:write')) return 'download';
  if (caps.some((c) => c.startsWith('provider:'))) return 'metadata';
  return 'other';
}

/** Plugin ids hold dots, which a `view-transition-name` ident only takes escaped. */
export function pluginPosterName(id: string): string {
  return `plugin-poster-${CSS.escape(id)}`;
}

/** Installed plugins, the catalogue and their actions, shared by the list and the detail page. */
@Injectable({ providedIn: 'root' })
export class PluginsState {
  private readonly api = inject(PluginsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly registry = inject(PluginUiRegistryService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);

  readonly rows = signal<PluginSummary[]>([]);
  readonly catalogue = signal<CatalogueRow[]>([]);
  readonly metricsByPluginId = signal<Map<string, PluginMetricsEntry>>(new Map());
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly refreshing = signal(false);
  readonly busyId = signal<string | null>(null);

  readonly installed = computed(() =>
    this.rows().map((row): PluginEntry => {
      const catalog = this.catalogue().find((c) => c.plugin.id === row.pluginId) ?? null;
      const latest = catalog?.latestVersion ?? null;
      return {
        id: row.pluginId,
        name: row.name,
        installed: row,
        catalog,
        updateTo: latest && compareVersions(latest, row.version) > 0 ? latest : null,
        logo: this.api.logoUrl(row.pluginId),
      };
    }),
  );

  /** Installed plugins, one group per category that has any. */
  readonly categories = computed(() =>
    CATEGORIES.map((id) => ({ id, entries: this.installed().filter((e) => categoryOf(e) === id) })).filter(
      (c) => c.entries.length,
    ),
  );

  /** Offered and not installed, once per plugin id across sources: what the detail page falls back to after an uninstall. */
  readonly available = computed(() => {
    const seen = new Set(this.rows().map((r) => r.pluginId));
    return this.catalogue()
      .filter((c) => !seen.has(c.plugin.id) && seen.add(c.plugin.id))
      .map((c): PluginEntry => ({
        id: c.plugin.id,
        name: c.plugin.name,
        installed: null,
        catalog: c,
        updateTo: null,
        logo: c.plugin.logo ? this.api.catalogLogoUrl(c.sourceId, c.plugin.id) : null,
      }));
  });

  /** In the UI language when the manifest translates it. */
  descriptionFor(entry: PluginEntry): string {
    const lang = this.translate.currentLang() || this.translate.fallbackLang() || 'en';
    const row = entry.installed;
    return row?.descriptions?.[lang] || row?.description || entry.catalog?.plugin.description || '';
  }

  entry(id: string): PluginEntry | null {
    return this.installed().find((e) => e.id === id) ?? this.available().find((e) => e.id === id) ?? null;
  }

  async reload(): Promise<void> {
    this.listError.set('');
    try {
      this.rows.set(await this.api.list());
    } catch {
      this.listError.set(this.translate.instant('settings.plugins.load_error'));
    } finally {
      this.loading.set(false);
    }
    await Promise.all([this.reloadCatalogue(), this.reloadMetrics()]);
  }

  /** Best-effort: without a catalog the installed plugins still show, minus their update badge. */
  async reloadCatalogue(): Promise<void> {
    try {
      this.catalogue.set((await this.api.catalogue()).rows);
    } catch {
      this.catalogue.set([]);
    }
  }

  private async reloadMetrics(): Promise<void> {
    try {
      const entries = await this.api.metrics();
      this.metricsByPluginId.set(new Map(entries.map((e) => [e.pluginId, e])));
    } catch {
      this.metricsByPluginId.set(new Map());
    }
  }

  subtitleFor(entry: PluginEntry): string {
    const row = entry.installed;
    if (!row) return entry.catalog?.plugin.author ?? '';
    const status = statusBadgeFor(row);
    const version = `v${row.version}`;
    return status.labelKey === 'settings.plugins.status_active'
      ? version
      : `${version} · ${this.translate.instant(status.labelKey)}`;
  }

  badgeFor(entry: PluginEntry): string | undefined {
    return entry.updateTo || entry.installed?.heldUpdate
      ? this.translate.instant('settings.plugins.update_badge')
      : undefined;
  }

  /** The card menu and the detail page list the same actions; `consent` opens the page's own sheet. */
  actionsFor(entry: PluginEntry, consent: (report: PluginInspectReport) => void, withDetails = true): CardAction[] {
    const actions: CardAction[] = withDetails
      ? [{ labelKey: 'settings.plugins.details', icon: 'file-text', route: `/admin/settings/plugins/${entry.id}`, run: () => undefined }]
      : [];
    const catalog = entry.catalog;
    const row = entry.installed;
    const install = (version: string) => () => void this.installVersion(catalog!, version, consent);
    if (!row) {
      if (catalog?.latestVersion) {
        actions.push({
          labelKey: 'settings.plugins.catalogue.install',
          icon: 'download',
          tone: 'success',
          run: install(catalog.latestVersion),
        });
      }
      return actions;
    }
    if (catalog && entry.updateTo) {
      actions.push({
        label: this.translate.instant('settings.plugins.catalogue.switch_to', { version: entry.updateTo }),
        icon: 'download',
        tone: 'success',
        run: install(entry.updateTo),
      });
    }
    actions.push(
      {
        labelKey: row.enabled ? 'settings.plugins.disable' : 'settings.plugins.enable',
        icon: row.enabled ? 'ban' : 'check',
        run: () => void this.toggleEnabled(row, !row.enabled),
      },
      { labelKey: 'settings.plugins.export.button', icon: 'database', run: () => void this.exportData(row) },
    );
    if (row.origin !== 'bundled') {
      actions.push({
        labelKey: 'settings.plugins.uninstall',
        icon: 'trash-2',
        tone: 'danger',
        section: 'danger',
        run: () => void this.uninstall(row),
      });
    }
    return actions;
  }

  async installVersion(row: CatalogueRow, version: string, consent: (report: PluginInspectReport) => void): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(row.plugin.id);
    try {
      consent(await this.api.inspectFromCatalog(row.sourceId, row.plugin.id, version));
    } catch {
      // The global error interceptor already toasts the server's message.
    } finally {
      this.busyId.set(null);
    }
  }

  async onInstalled(result: PluginInstallResult): Promise<void> {
    await this.reload();
    // The sidebar and the nav read the registry: without this a new plugin's pages stay unlinked.
    await this.registry.load();
    if (result.status === 'active') {
      this.toast.success(this.translate.instant('settings.plugins.installed'));
    } else {
      this.toast.warning(
        this.translate.instant('settings.plugins.install_failed_but_kept', {
          id: result.pluginId,
          reason: result.detail ?? result.reason ?? '',
        }),
      );
    }
  }

  /** Every enabled source at once; one failure does not stop the others. */
  async refreshAllSources(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    try {
      const sources = (await this.api.listSources()).filter((s) => s.enabled);
      const results = await Promise.all(
        sources.map((s) => this.api.refreshSource(s.id).catch(() => ({ ok: false as const }))),
      );
      const failed = sources.filter((_, i) => !results[i].ok).map((s) => s.url);
      if (failed.length) {
        this.toast.error(this.translate.instant('settings.plugins.sources.refresh_all_error', { list: failed.join(', ') }));
      } else {
        this.toast.success(this.translate.instant('settings.plugins.sources.refresh_all_ok'));
      }
      await this.reloadCatalogue();
    } finally {
      this.refreshing.set(false);
    }
  }

  async toggleEnabled(row: PluginSummary, enabled: boolean): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(row.pluginId);
    try {
      const updated = enabled ? await this.api.enable(row.pluginId) : await this.api.disable(row.pluginId);
      this.rows.update((rows) => rows.map((r) => (r.pluginId === updated.pluginId ? updated : r)));
      // The nav, the settings sidebar and every action slot read the registry.
      await this.registry.load();
      if (updated.status === 'failed') {
        this.toast.warning(
          this.translate.instant('settings.plugins.enable_failed_but_kept', {
            id: updated.pluginId,
            reason: updated.statusReason ?? '',
          }),
        );
      } else {
        this.toast.success(
          this.translate.instant(enabled ? 'settings.plugins.enabled_toast' : 'settings.plugins.disabled_toast'),
        );
      }
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.toggle_error'));
    } finally {
      this.busyId.set(null);
    }
  }

  async exportData(row: PluginSummary): Promise<void> {
    const { ok, toggle } = await this.confirmation.confirmWithToggle({
      title: this.translate.instant('settings.plugins.export.title', { name: row.name }),
      message: this.translate.instant('settings.plugins.export.message'),
      toggleLabel: this.translate.instant('settings.plugins.export.include_secrets'),
      toggleHint: this.translate.instant('settings.plugins.export.include_secrets_hint'),
    });
    if (!ok) return;
    try {
      await saveFile(await this.api.exportData(row.pluginId, toggle), `${row.pluginId}.export.json`);
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.export.error'));
    }
  }

  async uninstall(row: PluginSummary): Promise<void> {
    const tables =
      row.kind === 'process' ? await this.api.dataUsage(row.pluginId).then((u) => u.tables, () => []) : [];
    const summary = tables.map((t) => `${t.name} (${t.rows})`).join(', ');
    const { ok, toggle: deleteData } = await this.confirmation.confirmWithToggle({
      title: this.translate.instant('common.confirm'),
      message:
        this.translate.instant('settings.plugins.confirm_uninstall', { name: row.name }) +
        (summary ? ' ' + this.translate.instant('settings.plugins.uninstall_data_summary', { list: summary }) : ''),
      variant: 'danger',
      toggleLabel: this.translate.instant('settings.plugins.uninstall_delete_data'),
      toggleHint: this.translate.instant('settings.plugins.uninstall_delete_data_hint'),
    });
    if (!ok) return;

    try {
      await this.api.uninstall(row.pluginId, deleteData);
      await this.reload();
      await this.registry.load();
      this.toast.success(this.translate.instant('settings.plugins.uninstalled'));
      // On its detail page, a plugin no catalog offers has nothing left to show.
      if (!this.entry(row.pluginId) && this.router.url.startsWith(`/admin/settings/plugins/${row.pluginId}`)) {
        void this.router.navigateByUrl('/admin/settings/plugins');
      }
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.uninstall_error'));
    }
  }
}
