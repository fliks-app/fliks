import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  signal,
  inject,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LucideSnowflake } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { ToastService } from '../../../core/services/toast.service';
import { ProviderListComponent } from '../../../shared/components/provider-list/provider-list';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderInstance,
  ProviderListLabels,
  ProviderTestResult,
} from '../../../shared/components/provider-list/provider-list.types';

/** Live throttle state — mirrors `IndexersApiService`'s row shape, which the generic renderer passes through untouched. */
interface IndexerCooldown {
  reason: 'rate-limit' | 'failures';
  remainingMs: number;
  until: string;
  failureCount?: number;
  detail?: string;
}

const LABELS: ProviderListLabels = {
  newLabelKey: 'settings.indexers.new',
  colNameKey: 'settings.indexers.col_name',
  colImplementationKey: 'settings.indexers.field_type',
  colPriorityKey: 'settings.indexers.col_priority',
  colEnabledKey: 'settings.indexers.col_enabled',
  actionsKey: 'settings.indexers.actions',
  editKey: 'settings.indexers.edit',
  deleteKey: 'settings.indexers.delete',
  saveKey: 'settings.indexers.save',
  cancelKey: 'settings.indexers.cancel',
  createTitleKey: 'settings.indexers.editor_create',
  editTitleKey: 'settings.indexers.editor_edit',
  fieldNameKey: 'settings.indexers.field_name',
  fieldImplementationKey: 'settings.indexers.field_type',
  fieldPriorityKey: 'settings.indexers.field_priority',
  fieldEnabledKey: 'settings.indexers.field_enabled',
  emptyKey: 'settings.indexers.empty',
  loadErrorKey: 'settings.indexers.load_error',
  confirmDeleteKey: 'settings.indexers.confirm_delete',
  deleteErrorKey: 'settings.indexers.delete_error',
  testConnectionKey: 'settings.indexers.test_connection',
};

@Component({
  selector: 'app-indexers-settings',
  imports: [TranslateModule, LucideSnowflake, ProviderListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './indexers.html',
})
export class IndexersSettingsComponent {
  private readonly http = inject(HttpClient);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly providerList = viewChild<ProviderListComponent>('pl');
  private readonly statsDialog = viewChild<ElementRef<HTMLDialogElement>>('statsDialog');
  private readonly cooldownDialog = viewChild<ElementRef<HTMLDialogElement>>('cooldownDialog');

  readonly listUrl = '/api/indexers';
  readonly labels = LABELS;

  readonly statsLoading = signal(false);
  readonly statsData = signal<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>([]);
  readonly statsIndexerName = signal('');
  readonly languages = signal<{ id: number; name: string; isoCode: string }[]>([]);

  readonly cooldownRow = signal<ProviderInstance | null>(null);
  readonly resettingCooldown = signal(false);
  /** Ticks so countdowns tick down and expired windows drop without a refetch. */
  private readonly now = signal(Date.now());

  readonly implementations = computed<ProviderImplementation[]>(() => [
    {
      implementation: 'torznab',
      labelKey: 'settings.indexers.type_torznab',
      fields: [
        {
          key: 'baseUrl',
          type: 'url',
          labelKey: 'settings.indexers.field_torznab_base_url',
          placeholder: 'http://prowlarr:9696/1/api',
          required: true,
        },
        { key: 'apiKey', type: 'password', labelKey: 'settings.indexers.field_api_key', secret: true },
        {
          key: 'requestDelay',
          type: 'number',
          labelKey: 'settings.indexers.field_request_delay',
          default: 2,
          topLevel: true,
          hint: this.translate.instant('settings.indexers.request_delay_hint'),
        },
        { key: 'minSeeders', type: 'number', labelKey: 'settings.indexers.field_min_seeders', default: 0 },
        {
          key: 'seedRatio',
          type: 'number',
          labelKey: 'settings.indexers.field_seed_ratio',
          default: 1,
          hint: this.translate.instant('settings.indexers.seed_ratio_hint'),
        },
        {
          key: 'maxRetentionDays',
          type: 'number',
          labelKey: 'settings.indexers.field_max_retention',
          hint: this.translate.instant('settings.indexers.max_retention_hint'),
        },
        { key: 'enableSearch', type: 'toggle', labelKey: 'settings.indexers.field_enable_search', default: true, topLevel: true },
        {
          key: 'unknownLanguageIsoCode',
          type: 'select',
          labelKey: 'settings.indexers.field_unknown_language',
          hint: this.translate.instant('settings.indexers.unknown_language_hint'),
          options: [
            { value: '', labelKey: this.translate.instant('settings.indexers.unknown_language_none') },
            ...this.languages().map((l) => ({ value: l.isoCode, labelKey: `${l.name} (${l.isoCode})` })),
          ],
        },
      ],
    },
  ]);

  constructor() {
    void this.profilesApi.getLanguageDefinitions().then((langs) => this.languages.set(langs));
    const timer = setInterval(() => this.now.set(Date.now()), 5_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  cooldownOf(ix: ProviderInstance): IndexerCooldown | null | undefined {
    return ix['cooldown'] as IndexerCooldown | null | undefined;
  }

  isCooledDown(ix: ProviderInstance): boolean {
    const c = this.cooldownOf(ix);
    return !!c && Date.parse(c.until) > this.now();
  }

  hasCooldowns(rows: readonly ProviderInstance[]): boolean {
    return rows.some((r) => this.isCooledDown(r));
  }

  cooledDownCount(rows: readonly ProviderInstance[]): number {
    return rows.filter((r) => this.isCooledDown(r)).length;
  }

  /** Remaining window as `1 h 05 min`, `4 min 12 s`, `38 s`. */
  cooldownRemaining(ix: ProviderInstance): string {
    const c = this.cooldownOf(ix);
    if (!c) return '';
    const total = Math.max(0, Math.round((Date.parse(c.until) - this.now()) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
    return `${s} s`;
  }

  cooldownExpiresAt(ix: ProviderInstance): string {
    const c = this.cooldownOf(ix);
    return c ? new Date(c.until).toLocaleTimeString() : '';
  }

  openCooldown(ix: ProviderInstance) {
    this.cooldownRow.set(ix);
    this.cooldownDialog()?.nativeElement.showModal();
  }

  closeCooldown() {
    this.cooldownDialog()?.nativeElement.close();
  }

  async resetCooldown(ix: ProviderInstance) {
    this.resettingCooldown.set(true);
    try {
      await firstValueFrom(this.http.delete(`/api/indexers/${ix.id}/cooldown`));
      this.closeCooldown();
      await this.providerList()?.reload();
      this.toast.success(this.translate.instant('settings.indexers.cooldown_reset_done', { name: ix.name }));
    } finally {
      this.resettingCooldown.set(false);
    }
  }

  async resetAllCooldowns() {
    this.resettingCooldown.set(true);
    try {
      const { cleared } = await firstValueFrom(this.http.delete<{ cleared: number }>('/api/indexers/cooldowns'));
      await this.providerList()?.reload();
      this.toast.success(this.translate.instant('settings.indexers.cooldown_reset_all_done', { count: cleared }));
    } finally {
      this.resettingCooldown.set(false);
    }
  }

  async openStats(ix: ProviderInstance) {
    this.statsIndexerName.set(ix.name);
    this.statsLoading.set(true);
    this.statsDialog()?.nativeElement.showModal();
    try {
      this.statsData.set(
        await firstValueFrom(
          this.http.get<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>(
            `/api/indexers/${ix.id}/stats`,
          ),
        ),
      );
    } finally {
      this.statsLoading.set(false);
    }
  }

  closeStats() {
    this.statsDialog()?.nativeElement.close();
  }

  readonly testConnection = async (draft: ProviderDraft): Promise<ProviderTestResult> => {
    const base = String(draft.settings['baseUrl'] ?? '').trim();
    if (!base) return { ok: false, message: this.translate.instant('settings.indexers.base_url_required') };
    try {
      return await firstValueFrom(
        this.http.post<ProviderTestResult>('/api/indexers/test-connection', {
          implementation: 'torznab',
          settings: {
            ...draft.settings,
            baseUrl: base.replace(/\/$/, ''),
            apiKey: String(draft.settings['apiKey'] ?? '').trim(),
          },
        }),
      );
    } catch {
      return { ok: false, message: this.translate.instant('settings.indexers.test_network_error') };
    }
  };

  /** Mirrors the original hand-rolled save(): trims/strips the URL and drops falsy optional fields. */
  readonly beforeSave = (body: Record<string, unknown>): Record<string, unknown> => {
    const settings = { ...(body['settings'] as Record<string, unknown>) };
    if (typeof settings['baseUrl'] === 'string') settings['baseUrl'] = settings['baseUrl'].trim().replace(/\/$/, '');
    if (typeof settings['apiKey'] === 'string') settings['apiKey'] = settings['apiKey'].trim();
    if (!settings['maxRetentionDays']) delete settings['maxRetentionDays'];
    if (!settings['unknownLanguageIsoCode']) delete settings['unknownLanguageIsoCode'];
    return { ...body, settings };
  };
}
