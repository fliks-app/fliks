import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  SubtitleProvidersApiService,
  SubtitleProviderRow,
  ProviderRateLimit,
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

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly statsDialog = viewChild<ElementRef<HTMLDialogElement>>('statsDialog');

  readonly providerTypes = PROVIDER_TYPES;
  readonly rows = signal<SubtitleProviderRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly saving = signal(false);

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

  readonly rateLimits = signal<Map<string, ProviderRateLimit>>(new Map());

  readonly statsLoading = signal(false);
  readonly statsData = signal<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>([]);
  readonly statsProviderName = signal('');

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const [rows, limits] = await Promise.all([
        this.api.list(),
        this.api.getRateLimits(),
      ]);
      this.rows.set(rows);
      this.rateLimits.set(new Map(limits.map((l) => [l.providerType, l])));
    } catch {
      this.listError.set(this.translate.instant('settings.subtitle_providers.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  getRateLimit(type: string): ProviderRateLimit | undefined {
    return this.rateLimits().get(type);
  }

  formatDelay(seconds: number): string {
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.ceil((seconds % 3600) / 60);
      return m > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${h}h`;
    }
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return s > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${m}min`;
    }
    return `${seconds}s`;
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
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
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
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
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
    if (!name) return;
    const body = {
      name,
      type: this.formType(),
      priority: this.formPriority(),
      enabled: this.formEnabled(),
      settings: this.buildSettings(),
    };

    this.saving.set(true);
    const id = this.editingId();
    try {
      await (id == null ? this.api.create(body) : this.api.update(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async openStats(row: SubtitleProviderRow) {
    this.statsProviderName.set(row.name);
    this.statsLoading.set(true);
    this.statsDialog()?.nativeElement.showModal();
    try {
      const data = await this.api.getStats(row.id);
      this.statsData.set(data);
    } finally {
      this.statsLoading.set(false);
    }
  }

  closeStats() {
    this.statsDialog()?.nativeElement.close();
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
