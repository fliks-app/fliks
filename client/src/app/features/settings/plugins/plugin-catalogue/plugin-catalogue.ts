import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideChevronDown } from '@lucide/angular';
import {
  CatalogueRow,
  CatalogVersionEntry,
  PluginInspectReport,
  PluginsApiService,
} from '../../../../core/services/api/plugins-api.service';
import { compareVersions } from '../../../../core/utils/semver';
import { DropdownToggleDirective } from '../../../../shared/directives/dropdown-toggle.directive';
import { SelectedOptionDirective } from '../../../../shared/directives/selected-option.directive';

/** What every cached catalog offers, merged across sources. */
@Component({
  selector: 'app-plugin-catalogue',
  imports: [TranslatePipe, DropdownToggleDirective, LucideChevronDown, SelectedOptionDirective],
  templateUrl: './plugin-catalogue.html',
})
export class PluginCatalogueComponent implements OnInit {
  private readonly api = inject(PluginsApiService);
  private readonly translate = inject(TranslateService);

  readonly installedIds = input<ReadonlySet<string>>(new Set());
  /** Installed version per plugin id — what makes "already installed" and "out of date"
   *  distinguishable on a card. */
  readonly installedVersions = input<ReadonlyMap<string, string>>(new Map());
  /** `plugins.allow_older_versions`: off installs only the newest; on, a card splits into an action and a version picker. */
  readonly allowOlderVersions = input(false);

  /** A version was inspected and staged; the parent owns the consent sheet and opens it with this report. */
  readonly install = output<PluginInspectReport>();

  readonly rows = signal<CatalogueRow[]>([]);
  readonly hasAnySource = signal(true);
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly inspectingKey = signal<string | null>(null);

  ngOnInit(): void {
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    try {
      const { sources, rows } = await this.api.catalogue();
      this.hasAnySource.set(sources.length > 0);
      this.rows.set(rows);
    } catch {
      this.loadError.set(this.translate.instant('settings.plugins.catalogue.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** The newest version when it is above the installed one; null when absent or already as new. */
  updateTarget(row: CatalogueRow): string | null {
    const installed = this.installedVersions().get(row.plugin.id);
    if (!installed || !row.latestVersion) return null;
    return compareVersions(row.latestVersion, installed) > 0 ? row.latestVersion : null;
  }

  /** The version actually running, which is the only one a card has to state. What else the
   *  catalogue offers is the update button's business, not a list to read. */
  installedVersion(row: CatalogueRow): string | null {
    return this.installedVersions().get(row.plugin.id) ?? null;
  }

  isInstalled(pluginId: string): boolean {
    return this.installedIds().has(pluginId);
  }

  /** The installed plugin's extracted logo, else the one the server relays from the catalogue. */
  logoFor(row: CatalogueRow): string | null {
    if (this.isInstalled(row.plugin.id)) return this.api.logoUrl(row.plugin.id);
    return row.plugin.logo ? this.api.catalogLogoUrl(row.sourceId, row.plugin.id) : null;
  }

  hideBrokenLogo(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  /** What the version picker lists, newest first — a version list is read top down. */
  versionsFor(row: CatalogueRow): CatalogVersionEntry[] {
    return [...row.plugin.installable].reverse();
  }

  /** The version the button's left half acts on: the update target, else the newest for a plugin
   *  that is absent. Null once the newest is already running — the half then only states it. */
  primaryVersion(row: CatalogueRow): string | null {
    if (!this.isInstalled(row.plugin.id)) return row.latestVersion;
    return this.updateTarget(row);
  }

  async installVersion(row: CatalogueRow, version: string | null): Promise<void> {
    if (!version) return;
    this.inspectingKey.set(`${row.sourceId}:${row.plugin.id}:${version}`);
    try {
      const report = await this.api.inspectFromCatalog(row.sourceId, row.plugin.id, version);
      this.install.emit(report);
    } catch {
      // The global error interceptor already toasts the server's message; a second one here
      // showed the same text twice.
    } finally {
      this.inspectingKey.set(null);
    }
  }

  /** Any version of this card being staged, so both halves disable together. */
  isInspecting(row: CatalogueRow): boolean {
    return this.inspectingKey()?.startsWith(`${row.sourceId}:${row.plugin.id}:`) ?? false;
  }
}
