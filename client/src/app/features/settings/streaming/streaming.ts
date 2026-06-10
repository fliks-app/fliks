import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { StreamsApiService } from '../../../core/services/api/streams-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-streaming-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './streaming.html',
})
export class StreamingSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly streamsApi = inject(StreamsApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly saving = signal(false);

  readonly cacheBytes = signal(0);
  readonly cacheEntries = signal(0);
  readonly purging = signal(false);

  readonly segmentDuration = signal('3');
  readonly qsvPreset = signal('faster');
  readonly qsvLowPower = signal(false);
  readonly tonemapAlgo = signal('auto');
  /** How the "Auto" quality resolves: 'directplay' tries Direct Play first
   *  (zero transcoding when compatible), 'abr' always uses the adaptive HLS
   *  ladder. Explicit quality picks are unaffected. */
  readonly autoQualityMode = signal<'directplay' | 'abr'>('directplay');
  readonly autoQualityModes = ['directplay', 'abr'] as const;
  /** Tonemap algorithms the server reports as runnable on this host.
   *  When the list has a single entry (`['auto']` — e.g. macOS, or a
   *  Linux box with no OpenCL stack and no Intel iGPU), we hide the
   *  whole row in the template: the select would carry no meaningful
   *  choice. */
  readonly tonemapAlgosAvailable = signal<string[]>(['auto']);

  async ngOnInit() {
    try {
      const [all, algos] = await Promise.all([
        this.api.getAll(),
        this.streamingApi.getTonemapAlgos().catch(() => ({ available: ['auto'] })),
      ]);
      this.refreshCacheStats();
      this.segmentDuration.set(all['streaming_segment_duration'] ?? '3');
      this.qsvPreset.set(all['streaming_qsv_preset'] ?? 'faster');
      this.qsvLowPower.set(all['streaming_qsv_low_power'] === 'true');
      this.autoQualityMode.set(
        all['streaming_auto_quality_mode'] === 'abr' ? 'abr' : 'directplay',
      );
      this.tonemapAlgosAvailable.set(algos.available ?? ['auto']);
      // If the persisted value isn't runnable on this host (e.g. opencl
      // saved on a box where the probe failed after a driver change),
      // collapse back to 'auto' so the select stays in sync with what
      // the backend would actually do.
      const saved = all['streaming_tonemap_algo'] ?? 'auto';
      this.tonemapAlgo.set(
        this.tonemapAlgosAvailable().includes(saved) ? saved : 'auto',
      );
    } catch { /* interceptor */ }
    this.loading.set(false);
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        streaming_segment_duration: this.segmentDuration(),
        streaming_qsv_preset: this.qsvPreset(),
        streaming_qsv_low_power: String(this.qsvLowPower()),
        streaming_tonemap_algo: this.tonemapAlgo(),
        streaming_auto_quality_mode: this.autoQualityMode(),
      });
      this.toast.success(this.translate.instant('settings.streaming.saved'));
    } catch { /* interceptor */ }
    this.saving.set(false);
  }

  private async refreshCacheStats() {
    try {
      const stats = await this.streamsApi.transcodeCacheStats();
      this.cacheEntries.set(stats.entries);
      this.cacheBytes.set(stats.bytes);
    } catch { /* interceptor */ }
  }

  async purgeCache() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('settings.streaming.cache_purge_title'),
      message: this.translate.instant('settings.streaming.cache_purge_confirm'),
      confirmLabel: this.translate.instant('settings.streaming.cache_purge_action'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.purging.set(true);
    try {
      const freed = await this.streamsApi.purgeTranscodeCache();
      this.toast.success(
        this.translate.instant('settings.streaming.cache_purged', {
          entries: freed.entries,
          size: this.formatBytes(freed.bytes),
        }),
      );
      await this.refreshCacheStats();
    } catch { /* interceptor */ }
    this.purging.set(false);
  }

  formatBytes(bytes: number): string {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
    return `${bytes} B`;
  }
}
