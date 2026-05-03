import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CleanupProfilesApiService,
  CleanupProfile,
  CleanupProfileKey,
} from '../../../core/services/api/cleanup-profiles-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';

interface ProfileRow extends CleanupProfile {
  /** Local edit buffer — independent from the persisted value until Save. */
  draftSamples: number;
  draftIntervalMinutes: number;
  draftAutoRestart: boolean;
  saving: boolean;
}

@Component({
  selector: 'app-cleanup-profiles',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cleanup-profiles.html',
})
export class CleanupProfilesComponent implements OnInit {
  private readonly api = inject(CleanupProfilesApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly rows = signal<ProfileRow[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal('');

  readonly allowManualRestart = signal(false);
  readonly savingGlobal = signal(false);

  ngOnInit() {
    void this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.loadError.set('');
    try {
      const [list, settings] = await Promise.all([
        this.api.list(),
        this.settingsApi.getAll(),
      ]);
      const order: CleanupProfileKey[] = ['fast', 'medium', 'slow'];
      const sorted = order
        .map((key) => list.find((p) => p.key === key))
        .filter((p): p is CleanupProfile => !!p);
      this.rows.set(
        sorted.map((p) => ({
          ...p,
          draftSamples: p.samples,
          draftIntervalMinutes: p.intervalMinutes,
          draftAutoRestart: p.autoRestart,
          saving: false,
        })),
      );
      this.allowManualRestart.set(
        settings['cleanup_restart_manual_grabs'] === 'true',
      );
    } catch {
      this.loadError.set(
        this.translate.instant('settings.cleanup_profiles.load_error'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  /** Total detection time in minutes = (samples - 1) × intervalMinutes. */
  detectionMinutes(samples: number, interval: number): number {
    return Math.max(0, samples - 1) * interval;
  }

  formatDetection(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }

  updateDraftSamples(key: CleanupProfileKey, value: number) {
    this.rows.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, draftSamples: value } : r)),
    );
  }

  updateDraftInterval(key: CleanupProfileKey, value: number) {
    this.rows.update((rows) =>
      rows.map((r) =>
        r.key === key ? { ...r, draftIntervalMinutes: value } : r,
      ),
    );
  }

  updateDraftAutoRestart(key: CleanupProfileKey, value: boolean) {
    this.rows.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, draftAutoRestart: value } : r)),
    );
  }

  isDirty(row: ProfileRow): boolean {
    return (
      row.draftSamples !== row.samples ||
      row.draftIntervalMinutes !== row.intervalMinutes ||
      row.draftAutoRestart !== row.autoRestart
    );
  }

  async save(row: ProfileRow) {
    this.rows.update((rows) =>
      rows.map((r) => (r.key === row.key ? { ...r, saving: true } : r)),
    );
    try {
      const updated = await this.api.update(row.key, {
        samples: row.draftSamples,
        intervalMinutes: row.draftIntervalMinutes,
        autoRestart: row.draftAutoRestart,
      });
      this.rows.update((rows) =>
        rows.map((r) =>
          r.key === row.key
            ? {
                ...updated,
                draftSamples: updated.samples,
                draftIntervalMinutes: updated.intervalMinutes,
                draftAutoRestart: updated.autoRestart,
                saving: false,
              }
            : r,
        ),
      );
      this.toast.success(
        this.translate.instant('settings.cleanup_profiles.saved'),
      );
    } catch {
      this.rows.update((rows) =>
        rows.map((r) => (r.key === row.key ? { ...r, saving: false } : r)),
      );
    }
  }

  async saveGlobal() {
    this.savingGlobal.set(true);
    try {
      await this.settingsApi.set(
        'cleanup_restart_manual_grabs',
        String(this.allowManualRestart()),
      );
      this.toast.success(
        this.translate.instant('settings.cleanup_profiles.saved'),
      );
    } catch {
      // handled by interceptor
    } finally {
      this.savingGlobal.set(false);
    }
  }
}
