import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideEllipsisVertical } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import {
  PluginsApiService,
  PluginSummary,
  PluginInspectReport,
  PluginInstallResult,
} from '../../../core/services/api/plugins-api.service';
import { PluginInstallConsentComponent } from './plugin-install-consent/plugin-install-consent';
import { PluginSourcesComponent } from './plugin-sources/plugin-sources';
import { trustBadgeFor } from './plugin-trust';

@Component({
  selector: 'app-plugins-settings',
  imports: [
    RouterLink,
    LucideEllipsisVertical,
    TranslateModule,
    DropdownMenuComponent,
    ToggleFieldComponent,
    PluginInstallConsentComponent,
    PluginSourcesComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugins.html',
})
export class PluginsSettingsComponent implements OnInit {
  private readonly api = inject(PluginsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly registry = inject(PluginUiRegistryService);
  private readonly confirmation = inject(ConfirmationService);

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly consentSheet = viewChild<PluginInstallConsentComponent>('consentSheet');
  private readonly sourcesDialog = viewChild<PluginSourcesComponent>('sourcesDialog');

  readonly rows = signal<PluginSummary[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly uploading = signal(false);
  readonly togglingId = signal<string | null>(null);

  readonly trustBadgeFor = trustBadgeFor;

  ngOnInit(): void {
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.rows.set(await this.api.list());
    } catch {
      this.listError.set(this.translate.instant('settings.plugins.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  logoUrl(pluginId: string): string {
    return this.api.logoUrl(pluginId);
  }

  /** No logo entry, or the plugin isn't registered (a `failed` row) — the route 404s either way; keep the placeholder box empty. */
  hideBrokenLogo(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  pickFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  /** Inspect uploads to staging regardless of outcome; the consent sheet renders either the consent UI or the refusal. */
  async onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.uploading.set(true);
    try {
      const report: PluginInspectReport = await this.api.inspect(file);
      this.consentSheet()?.open(report);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.toast.error(httpErr.error?.message ?? this.translate.instant('settings.plugins.inspect_error'));
    } finally {
      this.uploading.set(false);
    }
  }

  openSources(): void {
    this.sourcesDialog()?.open();
  }

  async onInstalled(result: PluginInstallResult): Promise<void> {
    await this.reload();
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

  /** Idempotent on the backend, so a stray double-click never 409s — only the in-flight guard here matters for the UI. */
  /** What the row is actually doing, in the order that matters to an operator: their own off
   *  switch, then a failed activation, then a process that is up but not answering. */
  statusBadgeFor(row: PluginSummary): { labelKey: string; cssClass: string } {
    if (!row.enabled) return { labelKey: 'settings.plugins.status_disabled', cssClass: 'badge-ghost' };
    if (row.status === 'failed') return { labelKey: 'settings.plugins.status_failed', cssClass: 'badge-error' };
    if (row.processState && row.processState !== 'ready') {
      return { labelKey: 'settings.plugins.status_unavailable', cssClass: 'badge-warning' };
    }
    return { labelKey: 'settings.plugins.status_active', cssClass: 'badge-success' };
  }

  async toggleEnabled(row: PluginSummary, enabled: boolean): Promise<void> {
    if (this.togglingId()) return;
    this.togglingId.set(row.pluginId);
    try {
      const updated = enabled ? await this.api.enable(row.pluginId) : await this.api.disable(row.pluginId);
      this.rows.update((rows) => rows.map((r) => (r.pluginId === updated.pluginId ? updated : r)));
      // The nav, the settings sidebar and every action slot read the registry — without this
      // a toggled plugin's entries only appear or vanish on the next full page load.
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
      this.togglingId.set(null);
    }
  }

  async uninstall(row: PluginSummary): Promise<void> {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.plugins.confirm_uninstall', { name: row.name }),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await this.api.uninstall(row.pluginId);
      await this.reload();
      await this.registry.load();
      this.toast.success(this.translate.instant('settings.plugins.uninstalled'));
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.uninstall_error'));
    }
  }
}
