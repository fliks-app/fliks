import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  PluginsApiService,
  PluginInspectReport,
  PluginInstallResult,
} from '../../../../core/services/api/plugins-api.service';
import { trustBadgeFor, requiresAcknowledgement } from '../plugin-trust';
import { refusalMessageKey } from '../plugin-refusal';

/**
 * The install consent sheet. Owns the confirm call itself — the caller only
 * needs to open it with an inspect report and listen for `installed`.
 */
@Component({
  selector: 'app-plugin-install-consent',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-install-consent.html',
})
export class PluginInstallConsentComponent {
  private readonly api = inject(PluginsApiService);
  protected readonly translate = inject(TranslateService);

  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly report = signal<PluginInspectReport | null>(null);
  readonly acknowledged = signal(false);
  readonly confirming = signal(false);
  readonly error = signal('');

  readonly installed = output<PluginInstallResult>();

  readonly trust = computed(() => trustBadgeFor(this.report()?.signature));
  readonly requiresAck = computed(() => requiresAcknowledgement(this.report()?.signature));
  readonly canConfirm = computed(() => {
    const r = this.report();
    return !!r?.installable && !this.confirming() && (!this.requiresAck() || this.acknowledged());
  });
  readonly refusalMessage = computed(() => {
    const r = this.report();
    if (!r || r.installable) return '';
    return this.translate.instant(refusalMessageKey(r.refusalCode), { code: r.refusalCode ?? '' });
  });

  open(report: PluginInspectReport): void {
    this.report.set(report);
    this.acknowledged.set(false);
    this.confirming.set(false);
    this.error.set('');
    this.dialogRef().nativeElement.showModal();
  }

  close(): void {
    this.dialogRef().nativeElement.close();
  }

  /** `ui:<slot>` / `config:<id>` / `scope:<name>` / `job:<name>` / `webhook` — see `deriveCapabilities` on the backend. */
  capabilityLabel(capability: string): string {
    const separator = capability.indexOf(':');
    const prefix = separator === -1 ? capability : capability.slice(0, separator);
    const value = separator === -1 ? '' : capability.slice(separator + 1);
    switch (prefix) {
      case 'ui':
        return this.translate.instant('settings.plugins.consent.capability.ui', { value });
      case 'config':
        return this.translate.instant('settings.plugins.consent.capability.config', { value });
      case 'scope':
        return this.translate.instant('settings.plugins.consent.capability.scope', { value });
      case 'job':
        return this.translate.instant('settings.plugins.consent.capability.job', { value });
      case 'webhook':
        return this.translate.instant('settings.plugins.consent.capability.webhook');
      default:
        return capability;
    }
  }

  async confirm(): Promise<void> {
    const report = this.report();
    if (!report?.stagingId || !report.sha256 || !this.canConfirm()) return;

    this.confirming.set(true);
    this.error.set('');
    try {
      const result = await this.api.confirm(report.stagingId, report.sha256);
      this.close();
      this.installed.emit(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.error.set(httpErr.error?.message ?? this.translate.instant('common.error'));
    } finally {
      this.confirming.set(false);
    }
  }
}
