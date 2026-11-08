import { Component, ElementRef, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import { karaokeModelSize, type KaraokeModel, type KaraokeModels } from '../../../core/services/api/karaoke.models';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { formatBytes } from '../../../core/utils/format-bytes';
import { InputFieldComponent } from '../../../shared/components/forms/input-field/input-field';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

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
const MIN_BUDGET_MB = 256;

@Component({
  selector: 'app-karaoke-settings',
  imports: [FormsModule, TranslatePipe, InputFieldComponent, ToggleFieldComponent, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './karaoke-settings.html',
})
export class KaraokeSettingsComponent implements OnInit {
  private readonly api = inject(KaraokeApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly confirm = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('licence');

  protected readonly providers = VERIFIABLE_PROVIDERS;
  protected readonly minBudget = MIN_BUDGET_MB;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly enabled = signal(false);
  protected readonly background = signal(true);
  protected readonly budget = signal('4096');
  protected readonly verified = signal<string[]>(['coreml']);

  protected readonly catalogue = signal<KaraokeModels | null>(null);
  /** The engine is absent or lacks the model routes. */
  protected readonly unavailable = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly reviewing = signal<KaraokeModel | null>(null);
  protected readonly accepted = signal(false);
  protected readonly budgetValid = computed(() => Number(this.budget()) >= MIN_BUDGET_MB);

  constructor() {
    inject(SseService)
      .karaokeEvents.pipe(takeUntilDestroyed())
      .subscribe((e) => {
        if (e.type === 'sse.connected') void this.loadModels();
        else if (e.type === 'karaoke.model_changed') this.replace(e['model'] as KaraokeModel);
      });
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (!el) return;
      if (this.reviewing()) {
        if (!el.open) el.showModal();
      } else if (el.open) el.close();
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const all = await this.settingsApi.getAll();
      this.enabled.set(all['karaoke.enabled'] === 'true');
      this.background.set(all['karaoke.background'] !== 'false');
      this.budget.set(all['karaoke.disk_budget_mb'] ?? '4096');
      this.verified.set(parseProviders(all['karaoke.verified_providers']));
    } catch {
      // The interceptor toasts the reason; the defaults stay.
    }
    await this.loadModels();
    this.loading.set(false);
  }

  private async loadModels(): Promise<void> {
    try {
      this.catalogue.set(await this.api.models());
      this.unavailable.set(false);
    } catch (e) {
      if (!(e instanceof HttpErrorResponse) || e.status !== 503) this.toast.error(this.translate.instant('karaoke.admin.models_failed'));
      this.catalogue.set(null);
      this.unavailable.set(true);
    }
  }

  private replace(model: KaraokeModel): void {
    this.catalogue.update((c) => c && { ...c, models: c.models.map((m) => (m.id === model.id ? model : m)) });
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
        'karaoke.disk_budget_mb': String(Math.round(Number(this.budget()))),
        'karaoke.verified_providers': JSON.stringify(VERIFIABLE_PROVIDERS.filter((p) => this.verified().includes(p))),
      });
      this.toast.success(this.translate.instant('karaoke.admin.saved'));
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.saving.set(false);
    }
  }

  protected size(m: KaraokeModel): string {
    return formatBytes(karaokeModelSize(m));
  }

  protected percent(m: KaraokeModel): number {
    const total = karaokeModelSize(m);
    return total > 0 ? Math.min(100, (m.downloadedBytes / total) * 100) : 0;
  }

  protected review(m: KaraokeModel): void {
    this.accepted.set(false);
    this.reviewing.set(m);
  }

  protected closeReview(): void {
    this.reviewing.set(null);
  }

  protected canDownload(m: KaraokeModel): boolean {
    return m.state === 'absent' || m.state === 'failed';
  }

  protected async download(): Promise<void> {
    const m = this.reviewing();
    if (!m || !this.accepted()) return;
    this.reviewing.set(null);
    this.busy.set(m.id);
    try {
      this.replace(await this.api.download(m.id, true));
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.busy.set(null);
    }
  }

  protected async remove(m: KaraokeModel): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('karaoke.admin.delete_title', { name: m.name }),
      message: this.translate.instant('karaoke.admin.delete_message'),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    this.busy.set(m.id);
    try {
      await this.api.deleteModel(m.id);
      await this.loadModels();
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.busy.set(null);
    }
  }
}

function parseProviders(raw: string | null | undefined): string[] {
  if (raw == null) return ['coreml', 'cuda', 'migraphx'];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
