import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  DownloadClientsApiService,
  DownloadClientRow,
} from '../../../core/services/api/download-clients-api.service';

@Component({
  selector: 'app-download-clients-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download-clients.html',
})
export class DownloadClientsSettingsComponent implements OnInit {
  private readonly api = inject(DownloadClientsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly rows = signal<DownloadClientRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formType = signal<'qbittorrent'>('qbittorrent');
  readonly formHost = signal('localhost');
  readonly formPort = signal(8080);
  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formUseSsl = signal(false);
  readonly formCategory = signal('suitarr');
  readonly formMovieCategory = signal('');
  readonly formSeriesCategory = signal('');
  readonly formPriority = signal(1);
  readonly formEnabled = signal(true);

  readonly testLoading = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const list = await this.api.list();
      this.rows.set(list);
    } catch {
      this.listError.set(
        this.translate.instant('settings.download_clients.load_error'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formType.set('qbittorrent');
    this.formHost.set('localhost');
    this.formPort.set(8080);
    this.formUsername.set('');
    this.formPassword.set('');
    this.formUseSsl.set(false);
    this.formCategory.set('suitarr');
    this.formMovieCategory.set('');
    this.formSeriesCategory.set('');
    this.formPriority.set(1);
    this.formEnabled.set(true);
    this.saveError.set('');
    this.testResult.set(null);
    this.editorOpen.set(true);
  }

  openEdit(dc: DownloadClientRow) {
    this.editingId.set(dc.id);
    this.formName.set(dc.name);
    this.formType.set('qbittorrent');
    this.formHost.set(dc.settings.host ?? 'localhost');
    this.formPort.set(dc.settings.port ?? 8080);
    this.formUsername.set(dc.settings.username ?? '');
    this.formPassword.set('');
    this.formUseSsl.set(dc.settings.useSsl ?? false);
    this.formCategory.set(dc.settings.category ?? 'suitarr');
    this.formMovieCategory.set(dc.settings.movieCategory ?? '');
    this.formSeriesCategory.set(dc.settings.seriesCategory ?? '');
    this.formPriority.set(dc.priority);
    this.formEnabled.set(dc.enabled);
    this.saveError.set('');
    this.testResult.set(null);
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  private buildBody() {
    return {
      name: this.formName().trim(),
      implementation: this.formType(),
      settings: {
        host: this.formHost().trim(),
        port: this.formPort(),
        username: this.formUsername().trim() || undefined,
        password: this.formPassword() || undefined,
        useSsl: this.formUseSsl(),
        category: this.formCategory().trim() || undefined,
        movieCategory: this.formMovieCategory().trim() || undefined,
        seriesCategory: this.formSeriesCategory().trim() || undefined,
      },
      priority: this.formPriority(),
      enabled: this.formEnabled(),
    };
  }

  async testConnection() {
    this.testResult.set(null);
    this.testLoading.set(true);
    const body = {
      implementation: this.formType(),
      settings: {
        host: this.formHost().trim(),
        port: this.formPort(),
        username: this.formUsername().trim() || undefined,
        password: this.formPassword() || undefined,
        useSsl: this.formUseSsl(),
        category: this.formCategory().trim() || undefined,
      },
    };
    try {
      const r = await this.api.testConnection(body);
      this.testResult.set(r);
    } catch {
      this.testResult.set({
        ok: false,
        message: this.translate.instant('settings.download_clients.test_error'),
      });
    } finally {
      this.testLoading.set(false);
    }
  }

  async save() {
    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(
        this.translate.instant('settings.download_clients.name_required'),
      );
      return;
    }
    this.saving.set(true);
    this.saveError.set('');
    const id = this.editingId();
    try {
      await (id == null
        ? this.api.create(this.buildBody())
        : this.api.update(id, this.buildBody()));
      this.closeEditor();
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(
        msg ?? this.translate.instant('settings.download_clients.save_error'),
      );
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(dc: DownloadClientRow) {
    if (
      !await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.download_clients.confirm_delete', {
          name: dc.name,
        }),
        variant: 'danger',
      })
    )
      return;
    try {
      await this.api.remove(dc.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ??
          this.translate.instant('settings.download_clients.delete_error'),
        variant: 'danger',
      });
    }
  }
}
