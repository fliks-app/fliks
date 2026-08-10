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
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
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
  imports: [RouterLink, LucideEllipsisVertical, TranslateModule, DropdownMenuComponent, PluginInstallConsentComponent, PluginSourcesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugins.html',
})
export class PluginsSettingsComponent implements OnInit {
  private readonly api = inject(PluginsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly consentSheet = viewChild<PluginInstallConsentComponent>('consentSheet');
  private readonly sourcesDialog = viewChild<PluginSourcesComponent>('sourcesDialog');

  readonly rows = signal<PluginSummary[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly uploading = signal(false);

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
      this.toast.success(this.translate.instant('settings.plugins.uninstalled'));
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.uninstall_error'));
    }
  }
}
