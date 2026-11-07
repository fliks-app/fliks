import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { OptimizeService } from '../../../core/services/api/optimize.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  minutesToTime,
  timeToMinutes,
  type OptimizeSettings,
  type OptimizeWorker,
  type OriginalPolicy,
} from '../../../core/models/optimize';
import { InputFieldComponent } from '../../../shared/components/forms/input-field/input-field';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

const POLICIES: OriginalPolicy[] = ['trash', 'keep', 'delete'];

@Component({
  selector: 'app-optimize-settings',
  imports: [
    RouterLink,
    TranslatePipe,
    InputFieldComponent,
    SelectFieldComponent,
    ToggleFieldComponent,
  ],
  templateUrl: './optimize-settings.html',
})
export class OptimizeSettingsComponent implements OnInit {
  private readonly api = inject(OptimizeService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly policies = POLICIES;
  readonly loading = signal(true);
  readonly saving = signal(false);
  private current: OptimizeSettings | null = null;

  readonly windowOn = signal(false);
  readonly start = signal('22:00');
  readonly end = signal('06:00');
  readonly original = signal<OriginalPolicy>('trash');
  readonly retention = signal('7');
  readonly minFree = signal('20');
  readonly gpuReserve = signal('1');
  readonly cpuWeight = signal('2');
  /** Per device id: the job cap and the weight, blank = the device's own value. */
  readonly caps = signal<Record<string, string>>({});
  readonly weights = signal<Record<string, string>>({});
  readonly workers = signal<OptimizeWorker[]>([]);

  readonly deviceIds = computed(() => {
    const ids = new Set([
      ...this.workers().flatMap((w) => w.devices.map((d) => d.id)),
      ...Object.keys(this.caps()),
      ...Object.keys(this.weights()),
    ]);
    return [...ids].sort();
  });

  async ngOnInit() {
    try {
      const [s, workers] = await Promise.all([this.api.settings(), this.api.workers()]);
      this.current = s;
      this.workers.set(workers);
      this.windowOn.set(s.window != null);
      if (s.window) {
        this.start.set(minutesToTime(s.window.startMin));
        this.end.set(minutesToTime(s.window.endMin));
      }
      this.original.set(s.optimizeOriginal);
      this.retention.set(String(s.trashRetentionDays));
      this.minFree.set(String(s.trashMinFreeGb));
      this.gpuReserve.set(String(s.gpuPlaybackBeforePause));
      this.cpuWeight.set(String(s.cpuWeight));
      this.caps.set(
        Object.fromEntries(Object.entries(s.deviceMaxJobs).map(([k, v]) => [k, String(v)])),
      );
      this.weights.set(
        Object.fromEntries(Object.entries(s.deviceWeights).map(([k, v]) => [k, String(v)])),
      );
    } catch {
      // The global interceptor toasts the reason; the form stays hidden.
    } finally {
      this.loading.set(false);
    }
  }

  setDevice(kind: 'caps' | 'weights', id: string, v: string) {
    const sig = kind === 'caps' ? this.caps : this.weights;
    sig.update((m) => ({ ...m, [id]: v }));
  }

  /** Blank fields are left out: the device keeps its declared value. */
  private numbers(m: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(m).flatMap(([k, v]) =>
        v.trim() === '' ? [] : [[k, Math.round(Number(v))] as const],
      ),
    );
  }

  async save() {
    if (!this.current) return;
    const startMin = timeToMinutes(this.start());
    const endMin = timeToMinutes(this.end());
    if (this.windowOn() && (startMin == null || endMin == null || startMin === endMin)) {
      this.toast.error(this.translate.instant('settings.optimize.global.window_invalid'));
      return;
    }
    const body: OptimizeSettings = {
      ...this.current,
      window: this.windowOn() ? { startMin: startMin!, endMin: endMin! } : null,
      optimizeOriginal: this.original(),
      trashRetentionDays: Math.max(0, Math.round(Number(this.retention()) || 0)),
      trashMinFreeGb: Math.max(0, Math.round(Number(this.minFree()) || 0)),
      gpuPlaybackBeforePause: Math.max(0, Math.round(Number(this.gpuReserve()) || 0)),
      cpuWeight: Math.max(1, Math.round(Number(this.cpuWeight()) || 1)),
      deviceMaxJobs: this.numbers(this.caps()),
      deviceWeights: this.numbers(this.weights()),
    };
    this.saving.set(true);
    try {
      this.current = await this.api.saveSettings(body);
      this.toast.success(this.translate.instant('settings.optimize.global.saved'));
    } catch {
      // The global interceptor toasts the reason.
    } finally {
      this.saving.set(false);
    }
  }
}
