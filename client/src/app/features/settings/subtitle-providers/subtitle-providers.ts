import {
  Component,
  ElementRef,
  effect,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SECRETS_SET_KEY } from '@fliks/plugin-contract/ui';
import { SECRET_MASK } from '../../../shared/components/schema-form/schema-form';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import {
  SubtitleProvidersApiService,
  ProviderRateLimit,
} from '../../../core/services/api/subtitle-providers-api.service';
import {
  TranslationProvidersApiService,
  TranslationProviderRow,
  TranslationEngine,
} from '../../../core/services/api/translation-providers-api.service';
import { ProviderListComponent } from '../../../shared/components/provider-list/provider-list';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderInstance,
  ProviderListLabels,
  ProviderTestResult,
} from '../../../shared/components/provider-list/provider-list.types';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { EnabledSwitchComponent } from '../../../shared/components/enabled-switch';

const DEFAULT_TRANSLATION_MODEL = 'gemini-3.5-flash-lite';

/** Curated so a TV user picks from a list instead of typing a model id on a
 *  D-pad; Google retires ids over time, so this needs occasional upkeep. */
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemma-4-26b-a4b-it',
];

const TRANSLATION_ENGINES: { value: TranslationEngine; label: string }[] = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'libretranslate', label: 'LibreTranslate' },
];

const IMPLEMENTATIONS: ProviderImplementation[] = [
  {
    implementation: 'opensubtitles',
    labelKey: 'settings.subtitle_providers.type_opensubtitles',
    fields: [
      { key: 'username', type: 'text', labelKey: 'settings.subtitle_providers.field_username' },
      { key: 'password', type: 'password', labelKey: 'settings.subtitle_providers.field_password' },
    ],
  },
  {
    implementation: 'subdl',
    labelKey: 'settings.subtitle_providers.type_subdl',
    fields: [
      { key: 'apiKey', type: 'text', labelKey: 'settings.subtitle_providers.field_api_key' },
    ],
  },
  {
    implementation: 'subsynchro',
    labelKey: 'settings.subtitle_providers.type_subsynchro',
    fields: [],
  },
  {
    implementation: 'supersubtitles',
    labelKey: 'settings.subtitle_providers.type_supersubtitles',
    fields: [],
  },
  { implementation: 'yify', labelKey: 'settings.subtitle_providers.type_yify', fields: [] },
  { implementation: 'gestdown', labelKey: 'settings.subtitle_providers.type_gestdown', fields: [] },
];

const LABELS: ProviderListLabels = {
  newLabelKey: 'settings.subtitle_providers.new',
  colNameKey: 'settings.subtitle_providers.col_name',
  colImplementationKey: 'settings.subtitle_providers.col_type',
  colPriorityKey: 'settings.subtitle_providers.col_priority',
  colEnabledKey: 'common.active',
  actionsKey: 'settings.subtitle_providers.actions',
  editKey: 'settings.subtitle_providers.edit',
  deleteKey: 'settings.subtitle_providers.delete',
  saveKey: 'settings.subtitle_providers.save',
  cancelKey: 'settings.subtitle_providers.cancel',
  createTitleKey: 'settings.subtitle_providers.editor_create_title',
  editTitleKey: 'settings.subtitle_providers.editor_edit_title',
  fieldNameKey: 'settings.subtitle_providers.field_name',
  fieldImplementationKey: 'settings.subtitle_providers.field_type',
  fieldPriorityKey: 'settings.subtitle_providers.field_priority',
  fieldEnabledKey: 'settings.subtitle_providers.field_enabled',
  emptyKey: 'settings.subtitle_providers.empty',
  loadErrorKey: 'settings.subtitle_providers.load_error',
  confirmDeleteKey: 'settings.subtitle_providers.confirm_delete',
  deleteErrorKey: 'settings.subtitle_providers.delete_error',
  testConnectionKey: 'settings.subtitle_providers.test',
};

@Component({
  selector: 'app-subtitle-providers-settings',
  imports: [TvSelectDirective,
    NgTemplateOutlet,
    ModalFooterComponent,
    ModalHeaderComponent,
    FormsModule,
    TranslatePipe,
    ProviderListComponent,
    EnabledSwitchComponent,
  ],
  templateUrl: './subtitle-providers.html',
})
export class SubtitleProvidersSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly api = inject(SubtitleProvidersApiService);
  private readonly translationApi = inject(TranslationProvidersApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  private readonly translationEditorDialog =
    viewChild<ElementRef<HTMLDialogElement>>('translationEditorDialog');
  private readonly statsDialog = viewChild<ElementRef<HTMLDialogElement>>('statsDialog');

  readonly listUrl = '/api/subtitles/providers';
  readonly implementations = IMPLEMENTATIONS;
  readonly labels = LABELS;

  readonly rateLimits = signal<Map<string, ProviderRateLimit>>(new Map());

  readonly statsLoading = signal(false);
  readonly statsData = signal<
    { date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]
  >([]);
  readonly statsProviderName = signal('');

  // Machine-translation — a list of admin-configured providers plus the global
  // on/off master switch (still an app key/value setting).
  readonly translationEngines = TRANSLATION_ENGINES;
  readonly geminiModels = GEMINI_MODELS;
  readonly translationEnabled = signal(false);
  readonly savingTranslationEnabled = signal(false);
  readonly translationMaxConcurrency = signal(1);
  readonly savingConcurrency = signal(false);
  readonly translationRows = signal<TranslationProviderRow[]>([]);
  readonly translationLoading = signal(true);
  readonly togglingTranslationId = signal<number | null>(null);

  readonly trEditingId = signal<number | null>(null);
  /** The saved row's engine at open time, so a test after switching engines
   *  mid-edit doesn't send `id` and merge the old engine's stored key in. */
  readonly trEditingEngine = signal<TranslationEngine | null>(null);
  readonly trSaving = signal(false);
  readonly trFormName = signal('');
  readonly trFormEngine = signal<TranslationEngine>('gemini');
  readonly trFormEnabled = signal(true);
  readonly trFormDefault = signal(false);
  readonly trFormApiKey = signal('');
  readonly secretMask = SECRET_MASK;
  readonly trApiKeyStored = signal(false);
  readonly trApiKeyCleared = signal(false);
  readonly trFormModel = signal(DEFAULT_TRANSLATION_MODEL);
  readonly trFormBaseUrl = signal('');
  readonly trFormUrl = signal('');
  readonly trFormMaxTokensPerRequest = signal(0);
  readonly trFormTokensPerMinute = signal(0);
  readonly trTestLoading = signal(false);
  readonly trTestResult = signal<{ ok: boolean; message: string } | null>(null);

  // A saved verdict only describes the config it ran against; changing any of
  // it (engine and API key clear themselves elsewhere) must clear the badge.
  private readonly clearTrTestOnFieldChange = effect(() => {
    this.trFormModel();
    this.trFormBaseUrl();
    this.trFormUrl();
    this.trFormMaxTokensPerRequest();
    this.trFormTokensPerMinute();
    this.trTestResult.set(null);
  });

  ngOnInit() {
    void this.loadTranslationSettings();
    void this.reloadTranslationProviders();
  }

  async loadRateLimits() {
    try {
      const limits = await this.api.getRateLimits();
      this.rateLimits.set(new Map(limits.map((l) => [l.providerType, l])));
    } catch {
      // handled by global error interceptor
    }
  }

  private async loadTranslationSettings() {
    try {
      const all = await this.settingsApi.getAll();
      this.translationEnabled.set(all['subtitle_translation_enabled'] === 'true');
      this.translationMaxConcurrency.set(
        Math.max(1, Math.floor(Number(all['subtitle_translation_max_concurrency'] ?? '1')) || 1),
      );
    } catch {
      // handled by global error interceptor
    }
  }

  async saveTranslationConcurrency(value: number) {
    const n = Math.max(1, Math.floor(Number(value) || 1));
    this.translationMaxConcurrency.set(n);
    this.savingConcurrency.set(true);
    try {
      await this.settingsApi.setBulk({
        subtitle_translation_max_concurrency: String(n),
      });
    } finally {
      this.savingConcurrency.set(false);
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

  async toggleTranslationEnabled(row: TranslationProviderRow) {
    this.togglingTranslationId.set(row.id);
    try {
      await this.translationApi.update(row.id, { enabled: !row.enabled });
      await this.reloadTranslationProviders();
    } catch {
      // handled by global error interceptor
    } finally {
      this.togglingTranslationId.set(null);
    }
  }

  openCreateTranslation() {
    this.trEditingId.set(null);
    this.trEditingEngine.set(null);
    this.trFormName.set(this.translationEngineLabel('gemini'));
    this.trFormEngine.set('gemini');
    this.trFormEnabled.set(true);
    this.trFormDefault.set(this.translationRows().length === 0);
    this.trFormApiKey.set('');
    this.trApiKeyStored.set(false);
    this.trApiKeyCleared.set(false);
    this.trFormModel.set(DEFAULT_TRANSLATION_MODEL);
    this.trFormBaseUrl.set('');
    this.trFormUrl.set('');
    this.trFormMaxTokensPerRequest.set(0);
    this.trFormTokensPerMinute.set(0);
    this.trTestResult.set(null);
    this.translationEditorDialog()?.nativeElement.showModal();
  }

  openEditTranslation(row: TranslationProviderRow) {
    this.trEditingId.set(row.id);
    this.trEditingEngine.set(row.engine);
    this.trFormName.set(row.name);
    this.trFormEngine.set(row.engine);
    this.trFormEnabled.set(row.enabled);
    this.trFormDefault.set(row.isDefault);
    const s = row.settings ?? {};
    // The key never leaves the server; the response only says whether one is set.
    this.trFormApiKey.set('');
    const secretsSet = s[SECRETS_SET_KEY];
    this.trApiKeyStored.set(
      Array.isArray(secretsSet) && secretsSet.includes('apiKey'),
    );
    this.trApiKeyCleared.set(false);
    this.trFormModel.set(String(s['model'] ?? '') || DEFAULT_TRANSLATION_MODEL);
    this.trFormBaseUrl.set(String(s['baseUrl'] ?? ''));
    this.trFormUrl.set(String(s['url'] ?? ''));
    this.trFormMaxTokensPerRequest.set(Number(s['maxTokensPerRequest'] ?? 0) || 0);
    this.trFormTokensPerMinute.set(Number(s['tokensPerMinute'] ?? 0) || 0);
    this.trTestResult.set(null);
    this.translationEditorDialog()?.nativeElement.showModal();
  }

  onTranslationEngineChange(engine: TranslationEngine) {
    this.trFormEngine.set(engine);
    if (this.trEditingId() === null) {
      this.trFormName.set(this.translationEngineLabel(engine));
    }
    this.trTestResult.set(null);
  }

  closeTranslationEditor() {
    this.translationEditorDialog()?.nativeElement.close();
  }

  onTrApiKeyInput(value: string) {
    this.trFormApiKey.set(value);
    if (value.trim()) this.trApiKeyCleared.set(false);
    this.trTestResult.set(null);
  }

  /** Blank leaves the stored key alone, `null` erases it, as the API defines. */
  private trApiKeyValue(): string | null | undefined {
    if (this.trApiKeyCleared()) return null;
    const typed = this.trFormApiKey().trim();
    if (typed) return typed;
    return this.trApiKeyStored() ? undefined : '';
  }

  private buildTranslationSettings(): Record<string, unknown> {
    const engine = this.trFormEngine();
    if (engine === 'libretranslate') {
      return { url: this.trFormUrl().trim(), apiKey: this.trApiKeyValue() };
    }
    const budget = {
      maxTokensPerRequest: Math.max(0, Number(this.trFormMaxTokensPerRequest()) || 0),
      tokensPerMinute: Math.max(0, Number(this.trFormTokensPerMinute()) || 0),
    };
    if (engine === 'openai') {
      return {
        baseUrl: this.trFormBaseUrl().trim(),
        apiKey: this.trApiKeyValue(),
        model: this.trFormModel().trim(),
        ...budget,
      };
    }
    return {
      apiKey: this.trApiKeyValue(),
      model: this.trFormModel().trim() || DEFAULT_TRANSLATION_MODEL,
      ...budget,
    };
  }

  async testTranslation() {
    this.trTestResult.set(null);
    this.trTestLoading.set(true);
    try {
      // Lets the server resolve a stored key the editor never received, but only when
      // the engine hasn't changed; a switched engine would merge the wrong key in.
      const sameEngine =
        this.trEditingId() !== null && this.trFormEngine() === this.trEditingEngine();
      const res = await this.translationApi.testConnection({
        engine: this.trFormEngine(),
        settings: this.buildTranslationSettings(),
        ...(sameEngine ? { id: this.trEditingId()! } : {}),
      });
      this.trTestResult.set({
        ok: res.ok,
        message: res.ok
          ? this.translate.instant('settings.subtitle_providers.test_success')
          : res.error || this.translate.instant('settings.subtitle_providers.test_failed'),
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
      await (id == null ? this.translationApi.create(body) : this.translationApi.update(id, body));
      this.closeTranslationEditor();
      await this.reloadTranslationProviders();
    } catch {
      // handled by global error interceptor
    } finally {
      this.trSaving.set(false);
    }
  }

  async deleteTranslationProvider(row: TranslationProviderRow) {
    const msg = this.translate.instant('settings.subtitle_providers.confirm_delete', {
      name: row.name,
    });
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

  getRateLimit(type: string): ProviderRateLimit | undefined {
    return this.rateLimits().get(type);
  }

  async openStats(row: ProviderInstance) {
    this.statsProviderName.set(row.name);
    this.statsLoading.set(true);
    this.statsDialog()?.nativeElement.showModal();
    try {
      this.statsData.set(
        await firstValueFrom(
          this.http.get<
            {
              date: string;
              queries: number;
              avgResponseMs: number;
              totalResults: number;
              errors: number;
            }[]
          >(`/api/subtitles/providers/${row.id}/stats`),
        ),
      );
    } finally {
      this.statsLoading.set(false);
    }
  }

  closeStats() {
    this.statsDialog()?.nativeElement.close();
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

  private trimSettings(settings: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) out[k] = typeof v === 'string' ? v.trim() : v;
    return out;
  }

  readonly beforeSave = (body: Record<string, unknown>): Record<string, unknown> => ({
    ...body,
    settings: this.trimSettings(body['settings'] as Record<string, unknown>),
  });

  readonly testConnection = async (draft: ProviderDraft): Promise<ProviderTestResult> => {
    try {
      const { ok, detail } = await firstValueFrom(
        this.http.post<{ ok: boolean; detail?: string }>(
          '/api/subtitles/providers/test-connection',
          {
            type: draft.implementation,
            settings: this.trimSettings(draft.settings),
            ...(draft.id == null ? {} : { id: draft.id }),
          },
        ),
      );
      const verdict = this.translate.instant(
        ok ? 'settings.subtitle_providers.test_success' : 'settings.subtitle_providers.test_failed',
      );
      // `detail` is the provider's own reason (HTTP status, missing credential) — kept verbatim.
      return { ok, message: detail ? `${verdict} — ${detail}` : verdict };
    } catch {
      return {
        ok: false,
        message: this.translate.instant('settings.subtitle_providers.test_network_error'),
      };
    }
  };

  /** `row['type']` — `ProviderInstance` is generic; subtitle providers key their driver as `type`, not `implementation`. */
  implementationOf(row: ProviderInstance): string {
    return String(row['type'] ?? '');
  }
}
