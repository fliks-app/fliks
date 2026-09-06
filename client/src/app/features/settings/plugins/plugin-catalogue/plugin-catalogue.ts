import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideChevronDown } from '@lucide/angular';
import {
  CatalogPluginEntry,
  CatalogVersionEntry,
  PluginInspectReport,
  PluginsApiService,
} from '../../../../core/services/api/plugins-api.service';
import { DropdownToggleDirective } from '../../../../shared/directives/dropdown-toggle.directive';
import { SelectedOptionDirective } from '../../../../shared/directives/selected-option.directive';

interface CatalogueRow {
  sourceId: number;
  sourceUrl: string;
  plugin: CatalogPluginEntry;
  /** ponytail: last entry of `installable`, not a semver max — catalogs are expected to list
   *  versions oldest-to-newest; revisit with a real semver sort if a catalog ever violates that. */
  latestVersion: string | null;
}

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
  /** `plugins.allow_older_versions`: off, a card installs the newest and nothing else; on, it
   *  splits into an action and a version picker. The list itself is whatever the source cached —
   *  which the compatibility setting has already widened or narrowed. */
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
      const sources = await this.api.listSources();
      this.hasAnySource.set(sources.length > 0);

      const catalogs = await Promise.all(sources.map((s) => this.api.getSourceCatalog(s.id).catch(() => null)));
      const rows: CatalogueRow[] = [];
      sources.forEach((source, i) => {
        for (const plugin of catalogs[i]?.cachedCatalog?.plugins ?? []) {
          rows.push({
            sourceId: source.id,
            sourceUrl: source.url,
            plugin,
            latestVersion: plugin.installable.at(-1)?.version ?? null,
          });
        }
      });
      this.rows.set(rows);
    } catch {
      this.loadError.set(this.translate.instant('settings.plugins.catalogue.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** The version this card would install, when it is not the one already installed. Null when
   *  the plugin is absent or already on the catalogue's newest. The list is ordered oldest to
   *  newest by core's parser, so the last entry is the target without a semver comparison. */
  updateTarget(row: CatalogueRow): string | null {
    const installed = this.installedVersions().get(row.plugin.id);
    if (!installed || !row.latestVersion) return null;
    return installed === row.latestVersion ? null : row.latestVersion;
  }

  /** The version actually running, which is the only one a card has to state. What else the
   *  catalogue offers is the update button's business, not a list to read. */
  installedVersion(row: CatalogueRow): string | null {
    return this.installedVersions().get(row.plugin.id) ?? null;
  }

  isInstalled(pluginId: string): boolean {
    return this.installedIds().has(pluginId);
  }

  /** The catalogue's own URL, or — once installed — the logo core extracted from the archive,
   *  which is the only source until a catalogue publishes one. */
  logoFor(row: CatalogueRow): string | null {
    if (row.plugin.logo) return row.plugin.logo;
    return this.isInstalled(row.plugin.id) ? this.api.logoUrl(row.plugin.id) : null;
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
