import {
  Component,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  PluginsApiService,
  PluginInspectReport,
  PluginInstallResult,
} from '../../../../core/services/api/plugins-api.service';
import { trustBadgeFor, requiresAcknowledgement } from '../plugin-trust';
import { refusalMessageKey } from '../plugin-refusal';
import { capabilityLabels } from '../plugin-capability';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

/** The install consent sheet; owns the confirm call, so callers only open it with an inspect report and listen for `installed`. */
@Component({
  selector: 'app-plugin-install-consent',
  imports: [ModalFooterComponent, ModalHeaderComponent, FormsModule, TranslatePipe],
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

  private stagingId: string | null = null;

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
    this.stagingId = report.stagingId ?? null;
    this.acknowledged.set(false);
    this.confirming.set(false);
    this.error.set('');
    this.dialogRef().nativeElement.showModal();
  }

  close(): void {
    this.dialogRef().nativeElement.close();
  }

  /** Cancel, backdrop and Esc all land here: free the staging slot instead of waiting for the sweep. */
  discardUnconfirmed(): void {
    const id = this.stagingId;
    this.stagingId = null;
    if (id) void this.api.discardStaged(id).catch(() => undefined);
  }

  capabilityLabels(capabilities: readonly string[]): string[] {
    return capabilityLabels(this.translate, capabilities);
  }

  async confirm(): Promise<void> {
    const report = this.report();
    if (!report?.stagingId || !report.sha256 || !this.canConfirm()) return;

    this.confirming.set(true);
    this.error.set('');
    try {
      const result = await this.api.confirm(report.stagingId, report.sha256);
      this.stagingId = null;
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
