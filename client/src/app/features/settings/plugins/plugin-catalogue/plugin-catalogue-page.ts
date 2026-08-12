import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronLeft } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { PluginUiRegistryService } from '../../../../core/plugin-ui/plugin-ui-registry.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  PluginsApiService,
  PluginSummary,
  PluginInspectReport,
  PluginInstallResult,
} from '../../../../core/services/api/plugins-api.service';
import { PluginInstallConsentComponent } from '../plugin-install-consent/plugin-install-consent';
import { PluginCatalogueComponent } from './plugin-catalogue';

/** Routed wrapper around the catalogue grid — owns installed-state + the consent sheet, same as the plugins page did before this moved to its own route. */
@Component({
  selector: 'app-plugin-catalogue-page',
  imports: [RouterLink, LucideChevronLeft, TranslateModule, PluginInstallConsentComponent, PluginCatalogueComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-catalogue-page.html',
})
export class PluginCataloguePageComponent implements OnInit {
  private readonly api = inject(PluginsApiService);
  private readonly registry = inject(PluginUiRegistryService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  private readonly consentSheet = viewChild<PluginInstallConsentComponent>('consentSheet');

  private readonly rows = signal<PluginSummary[]>([]);
  readonly installedIds = computed(() => new Set(this.rows().map((r) => r.pluginId)));
  readonly installedVersions = computed(() => new Map(this.rows().map((r) => [r.pluginId, r.version])));

  ngOnInit(): void {
    this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.rows.set(await this.api.list());
    } catch {
      // best-effort — only feeds the "already installed" badge here
    }
  }

  /** From the catalogue's "Install" button — the report it staged opens the same consent sheet as a manual upload. */
  onInspected(report: PluginInspectReport): void {
    this.consentSheet()?.open(report);
  }

  async onInstalled(result: PluginInstallResult): Promise<void> {
    await this.reload();
    // The sidebar and the nav read the registry: without this a freshly installed plugin's
    // pages exist and nothing links to them until the next full page load.
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
}
