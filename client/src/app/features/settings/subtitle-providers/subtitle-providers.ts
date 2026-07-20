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
import { ToastService } from '../../../core/services/toast.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import {
  SubtitleProvidersApiService,
  SubtitleProviderRow,
  ProviderRateLimit,
} from '../../../core/services/api/subtitle-providers-api.service';
import {
  TranslationProvidersApiService,
  TranslationProviderRow,
  TranslationEngine,
} from '../../../core/services/api/translation-providers-api.service';

const DEFAULT_TRANSLATION_MODEL = 'gemini-2.0-flash';

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

const TRANSLATION_ENGINES: { value: TranslationEngine; label: string }[] = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'libretranslate', label: 'LibreTranslate' },
];

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
  private readonly translationApi = inject(TranslationProvidersApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly statsDialog = viewChild<ElementRef<HTMLDialogElement>>('statsDialog');
  private readonly translationEditorDialog = viewChild<ElementRef<HTMLDialogElement>>('translationEditorDialog');

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

  // Machine-translation — a list of admin-configured providers plus the global
  // on/off master switch (still an app key/value setting).
  readonly geminiModels = GEMINI_MODELS;
  readonly translationEngines = TRANSLATION_ENGINES;
  readonly translationEnabled = signal(false);
  readonly savingTranslationEnabled = signal(false);
  readonly translationRows = signal<TranslationProviderRow[]>([]);
  readonly translationLoading = signal(true);

  readonly trEditingId = signal<number | null>(null);
  readonly trSaving = signal(false);
  readonly trFormName = signal('');
  readonly trFormEngine = signal<TranslationEngine>('gemini');
  readonly trFormEnabled = signal(true);
  readonly trFormDefault = signal(false);
  readonly trFormApiKey = signal('');
  readonly trFormModel = signal(DEFAULT_TRANSLATION_MODEL);
  readonly trFormBaseUrl = signal('');
  readonly trFormUrl = signal('');
  readonly trTestLoading = signal(false);
  readonly trTestResult = signal<{ ok: boolean; message: string } | null>(null);

  ngOnInit() {
    this.reloadAll();
    void this.loadTranslationSettings();
    void this.reloadTranslationProviders();
  }

  private async loadTranslationSettings() {
    try {
      const all = await this.settingsApi.getAll();
      this.translationEnabled.set(all['subtitle_translation_enabled'] === 'true');
    } catch {
      // handled by global error interceptor
    }
  }

  async reloadTranslationProviders() {
    this.translationLoading.set(true);
    try {
      this.translationRows.set(await this.translationApi.list());
    } catch {
      // handled by global error interceptor
    } finally {
      this.translationLoading.set(false);
    }
  }

  async saveTranslationEnabled(enabled: boolean) {
    this.translationEnabled.set(enabled);
    this.savingTranslationEnabled.set(true);
    try {
      await this.settingsApi.setBulk({
        subtitle_translation_enabled: String(enabled),
      });
    } catch {
      this.translationEnabled.set(!enabled);
    } finally {
      this.savingTranslationEnabled.set(false);
    }
  }

  translationEngineLabel(engine: string): string {
    return TRANSLATION_ENGINES.find((e) => e.value === engine)?.label ?? engine;
  }

  openCreateTranslation() {
    this.trEditingId.set(null);
    this.trFormName.set(this.translationEngineLabel('gemini'));
    this.trFormEngine.set('gemini');
    this.trFormEnabled.set(true);
    this.trFormDefault.set(this.translationRows().length === 0);
    this.trFormApiKey.set('');
    this.trFormModel.set(DEFAULT_TRANSLATION_MODEL);
    this.trFormBaseUrl.set('');
    this.trFormUrl.set('');
    this.trTestResult.set(null);
    this.translationEditorDialog()?.nativeElement.showModal();
  }

  openEditTranslation(row: TranslationProviderRow) {
    this.trEditingId.set(row.id);
    this.trFormName.set(row.name);
    this.trFormEngine.set(row.engine);
    this.trFormEnabled.set(row.enabled);
    this.trFormDefault.set(row.isDefault);
    const s = row.settings ?? {};
    this.trFormApiKey.set(String(s['apiKey'] ?? ''));
    this.trFormModel.set(String(s['model'] ?? '') || DEFAULT_TRANSLATION_MODEL);
    this.trFormBaseUrl.set(String(s['baseUrl'] ?? ''));
    this.trFormUrl.set(String(s['url'] ?? ''));
    this.trTestResult.set(null);
    this.translationEditorDialog()?.nativeElement.showModal();
  }

  onTranslationEngineChange(engine: TranslationEngine) {
    this.trFormEngine.set(engine);
    if (this.trEditingId() === null) {
      this.trFormName.set(this.translationEngineLabel(engine));
    }
  }

  closeTranslationEditor() {
    this.translationEditorDialog()?.nativeElement.close();
  }

  private buildTranslationSettings(): Record<string, unknown> {
    const engine = this.trFormEngine();
    if (engine === 'openai') {
      return {
        baseUrl: this.trFormBaseUrl().trim(),
        apiKey: this.trFormApiKey().trim(),
        model: this.trFormModel().trim(),
      };
    }
    if (engine === 'libretranslate') {
      return { url: this.trFormUrl().trim(), apiKey: this.trFormApiKey().trim() };
    }
    return {
      apiKey: this.trFormApiKey().trim(),
      model: this.trFormModel().trim() || DEFAULT_TRANSLATION_MODEL,
    };
  }

  async testTranslation() {
    this.trTestResult.set(null);
    this.trTestLoading.set(true);
    try {
      const res = await this.translationApi.testConnection({
        engine: this.trFormEngine(),
        settings: this.buildTranslationSettings(),
      });
      this.trTestResult.set({
        ok: res.ok,
        message: res.ok
          ? this.translate.instant('settings.subtitle_providers.test_success')
          : res.error ||
            this.translate.instant('settings.subtitle_providers.test_failed'),
      });
    } catch {
      this.trTestResult.set({
        ok: false,
        message: this.translate.instant('settings.subtitle_providers.test_network_error'),
      });
    } finally {
      this.trTestLoading.set(false);
    }
  }

  async saveTranslationProvider() {
    const name = this.trFormName().trim();
    if (!name) return;
    const body = {
      name,
      engine: this.trFormEngine(),
      enabled: this.trFormEnabled(),
      isDefault: this.trFormDefault(),
      settings: this.buildTranslationSettings(),
    };
    this.trSaving.set(true);
    const id = this.trEditingId();
    try {
      await (id == null
        ? this.translationApi.create(body)
        : this.translationApi.update(id, body));
      this.closeTranslationEditor();
      await this.reloadTranslationProviders();
    } catch {
      // handled by global error interceptor
    } finally {
      this.trSaving.set(false);
    }
  }

  async deleteTranslationProvider(row: TranslationProviderRow) {
    const msg = this.translate.instant(
      'settings.subtitle_providers.confirm_delete',
      { name: row.name },
    );
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: msg,
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.translationApi.remove(row.id);
      await this.reloadTranslationProviders();
    } catch {
      // handled by global error interceptor
    }
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
