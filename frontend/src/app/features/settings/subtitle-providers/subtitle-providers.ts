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
  SubtitleProvidersApiService,
  SubtitleProviderRow,
} from '../../../core/services/api/subtitle-providers-api.service';

const PROVIDER_TYPES = [
  { value: 'opensubtitles', label: 'OpenSubtitles', fields: ['username', 'password'] },
  { value: 'subdl', label: 'Subdl', fields: ['apiKey'] },
  { value: 'subsynchro', label: 'Subsynchro', fields: [] },
  { value: 'supersubtitles', label: 'Supersubtitles', fields: [] },
  { value: 'yify', label: 'YIFY (yts-subs.com)', fields: [] },
  { value: 'gestdown', label: 'Gestdown (Addic7ed mirror)', fields: [] },
];

@Component({
  selector: 'app-subtitle-providers-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitle-providers.html',
})
export class SubtitleProvidersSettingsComponent implements OnInit {
  private readonly api = inject(SubtitleProvidersApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly providerTypes = PROVIDER_TYPES;
  readonly rows = signal<SubtitleProviderRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formType = signal('opensubtitles');
  readonly formPriority = signal(25);
  readonly formEnabled = signal(true);
  readonly formApiKey = signal('');
  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formBaseUrl = signal('');

  readonly testLoading = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.rows.set(await this.api.list());
    } catch {
      this.listError.set(this.translate.instant('settings.subtitle_providers.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  currentFields(): string[] {
    return PROVIDER_TYPES.find((t) => t.value === this.formType())?.fields ?? [];
  }

  providerLabel(type: string): string {
    return PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type;
  }

  onTypeChange(type: string) {
    this.formType.set(type);
    // Auto-fill name with provider label when creating
    if (this.editingId() === null) {
      this.formName.set(this.providerLabel(type));
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formType.set('opensubtitles');
    this.formName.set(this.providerLabel('opensubtitles'));
    this.formPriority.set(25);
    this.formEnabled.set(true);
    this.formApiKey.set('');
    this.formUsername.set('');
    this.formPassword.set('');
    this.formBaseUrl.set('');
    this.saveError.set('');
    this.testResult.set(null);
    this.editorOpen.set(true);
  }

  openEdit(row: SubtitleProviderRow) {
    this.editingId.set(row.id);
    this.formName.set(row.name);
    this.formType.set(row.type);
    this.formPriority.set(row.priority);
    this.formEnabled.set(row.enabled);
    const s = row.settings ?? {};
    this.formApiKey.set(String(s['apiKey'] ?? ''));
    this.formUsername.set(String(s['username'] ?? ''));
    this.formPassword.set(String(s['password'] ?? ''));
    this.formBaseUrl.set(String(s['baseUrl'] ?? ''));
    this.saveError.set('');
    this.testResult.set(null);
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  private buildSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    const fields = this.currentFields();
    if (fields.includes('apiKey')) settings['apiKey'] = this.formApiKey().trim();
    if (fields.includes('username')) settings['username'] = this.formUsername().trim();
    if (fields.includes('password')) settings['password'] = this.formPassword().trim();
    if (fields.includes('baseUrl')) settings['baseUrl'] = this.formBaseUrl().trim();
    return settings;
  }

  async testConnection() {
    this.testResult.set(null);
    this.testLoading.set(true);
    try {
      const ok = await this.api.testConnection({
        type: this.formType(),
        settings: this.buildSettings(),
      });
      this.testResult.set({
        ok,
        message: ok
          ? this.translate.instant('settings.subtitle_providers.test_success')
          : this.translate.instant('settings.subtitle_providers.test_failed'),
      });
    } catch {
      this.testResult.set({
        ok: false,
        message: this.translate.instant('settings.subtitle_providers.test_network_error'),
      });
    } finally {
      this.testLoading.set(false);
    }
  }

  async save() {
    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(this.translate.instant('settings.subtitle_providers.name_required'));
      return;
    }
    const body = {
      name,
      type: this.formType(),
      priority: this.formPriority(),
      enabled: this.formEnabled(),
      settings: this.buildSettings(),
    };

    this.saving.set(true);
    this.saveError.set('');
    const id = this.editingId();
    try {
      await (id == null ? this.api.create(body) : this.api.update(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.subtitle_providers.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(row: SubtitleProviderRow) {
    const msg = this.translate.instant('settings.subtitle_providers.confirm_delete', { name: row.name });
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })) return;
    try {
      await this.api.remove(row.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? this.translate.instant('settings.subtitle_providers.delete_error'), variant: 'danger' });
    }
  }
}
