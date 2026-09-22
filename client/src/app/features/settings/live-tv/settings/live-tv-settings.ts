import { Component, OnInit, WritableSignal, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { SettingsApiService } from '../../../../core/services/api/settings-api.service';
import { ToastService } from '../../../../core/services/toast.service';

type FastZapMode = 'auto' | 'true' | 'false';

/** Mirrors the backend's own `settingInt` helper so the prefilled value matches
 *  what the server actually falls back to for an absent or unparsable key. */
function parseIntOr(raw: string | null | undefined, fallback: number): number {
  const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

@Component({
  selector: 'app-live-tv-settings',
  imports: [FormsModule, TranslatePipe, TvSelectDirective],
  templateUrl: './live-tv-settings.html',
})
export class LiveTvSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly saving = signal(false);

  readonly guideDaysPast = signal(2);
  readonly guideDaysFuture = signal(7);
  readonly segmentSeconds = signal(2);
  readonly timeshiftMinutes = signal(15);
  readonly channelIdleSeconds = signal(30);
  readonly probeSeconds = signal(3);
  readonly staleStreamDays = signal(7);
  readonly slotReleaseSeconds = signal(15);
  readonly fastZap = signal<FastZapMode>('auto');

  /** Only the keys the admin actually touched are sent, so an untouched field
   *  never overwrites a value another session (or an env var upstream) set. */
  private readonly dirtyKeys = new Set<string>();

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.guideDaysPast.set(parseIntOr(map['livetv_guide_days_past'], 2));
      this.guideDaysFuture.set(parseIntOr(map['livetv_guide_days_future'], 7));
      this.segmentSeconds.set(parseIntOr(map['livetv_segment_seconds'], 2));
      this.timeshiftMinutes.set(parseIntOr(map['livetv_timeshift_minutes'], 15));
      this.channelIdleSeconds.set(parseIntOr(map['livetv_channel_idle_seconds'], 30));
      this.probeSeconds.set(parseIntOr(map['livetv_probe_seconds'], 3));
      this.staleStreamDays.set(parseIntOr(map['livetv_stale_stream_days'], 7));
      this.slotReleaseSeconds.set(parseIntOr(map['livetv_slot_release_seconds'], 15));
      const rawFastZap = map['livetv_fast_zap'];
      this.fastZap.set(rawFastZap === 'true' || rawFastZap === 'false' ? rawFastZap : 'auto');
    } catch { /* interceptor */ }
    this.loading.set(false);
  }

  touch(key: string): void {
    this.dirtyKeys.add(key);
  }

  /** Mirrors the backend parse: a fraction is truncated and NaN falls back, so
   *  clamping here means Save can never write a value the server would ignore. */
  setInt(target: WritableSignal<number>, key: string, raw: number | null): void {
    if (raw == null || !Number.isFinite(raw) || raw < 0) return;
    target.set(Math.trunc(raw));
    this.touch(key);
  }

  setFastZap(mode: FastZapMode): void {
    this.fastZap.set(mode);
    this.touch('livetv_fast_zap');
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      const changes = this.buildChanges();
      if (Object.keys(changes).length > 0) {
        await this.api.setBulk(changes);
      }
      this.dirtyKeys.clear();
      this.toast.success(this.translate.instant('liveTv.admin.settings.saved'));
    } catch { /* interceptor */ } finally { this.saving.set(false); }
  }

  /** "auto" sends `null`, which clears the override row instead of storing the
   *  literal string "auto": the backend only ever reads "true"/"false"/absent. */
  private buildChanges(): Record<string, string | null> {
    const changes: Record<string, string | null> = {};
    const set = (key: string, value: string | null) => {
      if (this.dirtyKeys.has(key)) changes[key] = value;
    };
    set('livetv_guide_days_past', String(this.guideDaysPast()));
    set('livetv_guide_days_future', String(this.guideDaysFuture()));
    set('livetv_segment_seconds', String(this.segmentSeconds()));
    set('livetv_timeshift_minutes', String(this.timeshiftMinutes()));
    set('livetv_channel_idle_seconds', String(this.channelIdleSeconds()));
    set('livetv_probe_seconds', String(this.probeSeconds()));
    set('livetv_stale_stream_days', String(this.staleStreamDays()));
    set('livetv_slot_release_seconds', String(this.slotReleaseSeconds()));
    set('livetv_fast_zap', this.fastZap() === 'auto' ? null : this.fastZap());
    return changes;
  }
}
