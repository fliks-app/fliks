import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideX } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { ToastService } from '../../../../core/services/toast.service';
import { PluginsApiService, PluginSourceRow } from '../../../../core/services/api/plugins-api.service';

/** One `code` per backend refusal (`plugin-sources.controller.ts`) — never the raw `detail`, which is not translated. */
function createErrorKey(code: string | undefined): string {
  switch (code) {
    case 'PLUGIN_SOURCE_INSECURE_URL':
      return 'settings.plugins.sources.errors.url_https';
    case 'PLUGIN_SOURCE_DUPLICATE_URL':
      return 'settings.plugins.sources.errors.url_duplicate';
    case 'PLUGIN_SOURCE_BAD_KEY':
      return 'settings.plugins.sources.errors.key_invalid';
    default:
      return 'settings.plugins.sources.errors.generic';
  }
}

/** Sources list + add form (`plans/plugin-system.plan.md`, "N per install, the official one is just the seeded first"). */
@Component({
  selector: 'app-plugin-sources',
  imports: [FormsModule, DatePipe, LucideX, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-sources.html',
})
export class PluginSourcesComponent implements OnInit {
  private readonly api = inject(PluginsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);

  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly sources = signal<PluginSourceRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly refreshingId = signal<number | null>(null);
  readonly savingId = signal<number | null>(null);

  readonly formUrl = signal('');
  readonly formPublicKey = signal('');
  readonly formEnabled = signal(true);
  readonly creating = signal(false);
  readonly createError = signal('');

  /** A source was added, removed or refreshed — the catalogue view needs to reload too. */
  readonly changed = output<void>();

  ngOnInit(): void {
    this.reload();
  }

  open(): void {
    this.dialogRef().nativeElement.showModal();
  }

  close(): void {
    this.dialogRef().nativeElement.close();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.sources.set(await this.api.listSources());
    } catch {
      this.listError.set(this.translate.instant('settings.plugins.sources.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async submitCreate(): Promise<void> {
    const url = this.formUrl().trim();
    if (!url || this.creating()) return;

    this.creating.set(true);
    this.createError.set('');
    try {
      const publicKey = this.formPublicKey().trim() || undefined;
      await this.api.createSource({ url, publicKey, enabled: this.formEnabled() });
      this.formUrl.set('');
      this.formPublicKey.set('');
      this.formEnabled.set(true);
      await this.reload();
      this.toast.success(this.translate.instant('settings.plugins.sources.added'));
      this.changed.emit();
    } catch (err: unknown) {
      const httpErr = err as { error?: { code?: string } };
      this.createError.set(this.translate.instant(createErrorKey(httpErr.error?.code)));
    } finally {
      this.creating.set(false);
    }
  }

  async toggleEnabled(row: PluginSourceRow): Promise<void> {
    this.savingId.set(row.id);
    try {
      await this.api.updateSource(row.id, { enabled: !row.enabled });
      await this.reload();
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.sources.update_error'));
    } finally {
      this.savingId.set(null);
    }
  }

  async refresh(row: PluginSourceRow): Promise<void> {
    this.refreshingId.set(row.id);
    try {
      const result = await this.api.refreshSource(row.id);
      if (result.ok) {
        this.toast.success(this.translate.instant('settings.plugins.sources.refresh_ok'));
      } else {
        this.toast.error(this.translate.instant('settings.plugins.sources.refresh_error', { detail: result.detail }));
      }
      await this.reload();
      this.changed.emit();
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.sources.refresh_error', { detail: '' }));
    } finally {
      this.refreshingId.set(null);
    }
  }

  async remove(row: PluginSourceRow): Promise<void> {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.plugins.sources.confirm_delete', { url: row.url }),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await this.api.deleteSource(row.id);
      await this.reload();
      this.toast.success(this.translate.instant('settings.plugins.sources.deleted'));
      this.changed.emit();
    } catch {
      this.toast.error(this.translate.instant('settings.plugins.sources.delete_error'));
    }
  }
}
