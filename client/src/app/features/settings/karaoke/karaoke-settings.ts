import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import type { KaraokeModel, KaraokeModels } from '../../../core/services/api/karaoke.models';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { InputFieldComponent } from '../../../shared/components/forms/input-field/input-field';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { KaraokeModelsComponent } from './karaoke-models';

/** The engine's provider names: each is ticked once `provider-check` showed it matches the CPU. */
export const VERIFIABLE_PROVIDERS = [
  'cuda',
  'nvtensorrtrtx',
  'amdgpu',
  'migraphx',
  'coreml',
  'openvino',
  'qnn',
  'vitisai',
  'webgpu',
  'directml',
] as const;
/** The verifiable providers the engine reports, in display order; the rest stay stored untouched. */
export function reportedProviders(reported: readonly string[]): string[] {
  return VERIFIABLE_PROVIDERS.filter((p) => reported.includes(p));
}
const MIN_BUDGET_MB = 256;
/** Microsoft's page of the Windows App SDK runtime installers, which hold the Windows ML runtime. */
export const WINDOWS_ML_INSTALL_URL = 'https://learn.microsoft.com/windows/apps/windows-app-sdk/downloads';

@Component({
  selector: 'app-karaoke-settings',
  imports: [FormsModule, TranslatePipe, InputFieldComponent, ToggleFieldComponent, KaraokeModelsComponent],
  templateUrl: './karaoke-settings.html',
})
export class KaraokeSettingsComponent implements OnInit {
  private readonly api = inject(KaraokeApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly minBudget = MIN_BUDGET_MB;
  protected readonly windowsMlUrl = WINDOWS_ML_INSTALL_URL;
  protected readonly checking = signal(false);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly enabled = signal(false);
  protected readonly background = signal(true);
  protected readonly autoDownload = signal(false);
  protected readonly budget = signal('4096');
  protected readonly queueCap = signal('2');
  protected readonly verified = signal<string[]>(['coreml']);

  protected readonly catalogue = signal<KaraokeModels | null>(null);
  /** The engine is absent or lacks the model routes. */
  protected readonly unavailable = signal(false);
  protected readonly providers = computed(() => reportedProviders(this.catalogue()?.runtime.providers ?? []));
  protected readonly budgetValid = computed(() => Number(this.budget()) >= MIN_BUDGET_MB);

  constructor() {
    inject(SseService)
      .karaokeEvents.pipe(takeUntilDestroyed())
      .subscribe((e) => {
        if (e.type === 'sse.connected') void this.loadModels();
        else if (e.type === 'karaoke.model_changed') this.replace(e['model'] as KaraokeModel);
      });
  }

  async ngOnInit(): Promise<void> {
    try {
      const all = await this.settingsApi.getAll();
      this.enabled.set(all['karaoke.enabled'] === 'true');
      this.background.set(all['karaoke.background'] !== 'false');
      this.autoDownload.set(all['karaoke.auto_download'] === 'true');
      this.budget.set(all['karaoke.disk_budget_mb'] ?? '4096');
      this.queueCap.set(all['karaoke.queue_cap'] ?? '2');
      this.verified.set(parseProviders(all['karaoke.verified_providers']));
    } catch {
      // The interceptor toasts the reason; the defaults stay.
    }
    await this.loadModels();
    this.loading.set(false);
  }

  protected async loadModels(): Promise<void> {
    try {
      this.catalogue.set(await this.api.models());
      this.unavailable.set(false);
    } catch (e) {
      if (!(e instanceof HttpErrorResponse) || e.status !== 503) this.toast.error(this.translate.instant('karaoke.admin.models_failed'));
      this.catalogue.set(null);
      this.unavailable.set(true);
    }
  }

  protected async recheck(): Promise<void> {
    this.checking.set(true);
    await this.loadModels();
    this.checking.set(false);
  }

  /** Progress updates swap the model in place; a new state also moves the disk figures, so the catalogue loads again. */
  private replace(model: KaraokeModel): void {
    if (this.catalogue()?.models.find((m) => m.id === model.id)?.state !== model.state) void this.loadModels();
    else this.catalogue.update((c) => c && { ...c, models: c.models.map((m) => (m.id === model.id ? model : m)) });
  }

  protected toggleProvider(p: string, on: boolean): void {
    this.verified.update((v) => (on ? [...new Set([...v, p])] : v.filter((x) => x !== p)));
  }

  protected async save(): Promise<void> {
    if (!this.budgetValid()) return;
    this.saving.set(true);
    try {
      await this.settingsApi.setBulk({
        'karaoke.enabled': String(this.enabled()),
        'karaoke.background': String(this.background()),
        'karaoke.auto_download': String(this.autoDownload()),
        'karaoke.disk_budget_mb': String(Math.round(Number(this.budget()))),
        'karaoke.queue_cap': String(Math.min(20, Math.max(1, Math.round(Number(this.queueCap()))))),
        'karaoke.verified_providers': JSON.stringify(VERIFIABLE_PROVIDERS.filter((p) => this.verified().includes(p))),
      });
      this.toast.success(this.translate.instant('karaoke.admin.saved'));
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.saving.set(false);
    }
  }
}

function parseProviders(raw: string | null | undefined): string[] {
  if (raw == null) return ['coreml', 'cuda', 'migraphx', 'directml'];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
