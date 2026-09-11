import { Component, inject, signal, OnInit } from '@angular/core';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { StreamsApiService } from '../../../core/services/api/streams-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-streaming-settings',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, ToggleFieldComponent],
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
  /** The footprint is a recursive walk of every cached segment, so it lands
   *  well after the page. Until it does, 0 entries is unknown, not empty. */
  readonly cacheStatsLoaded = signal(false);
  readonly purging = signal(false);

  readonly segmentDuration = signal('3');
  readonly qsvPreset = signal('faster');
  readonly tonemapAlgo = signal('auto');
  /** HDR to SDR curve. Only the OpenCL and CPU paths apply it; the vpp_qsv and
   *  tonemap_vaapi fixed-function LUTs ignore it. */
  readonly tonemapCurve = signal('hable');
  /** Transcode-cache budget and retention. Blank = keep the server default
   *  (the env var, or 20 GB / 4 h). */
  readonly cacheMaxGb = signal('');
  readonly cacheTtlHours = signal('');
  /** Concurrent background ffmpeg jobs (scans, thumbnails, marker detection).
   *  Blank = the cgroup/CPU-derived budget shown in {@link ffmpegSlotsAuto}. */
  readonly ffmpegSlots = signal('');
  readonly ffmpegSlotsAuto = signal(0);
  /** When off, detected black bars are kept instead of cropped — avoids a
   *  forced re-encode on low-power servers. Default on. */
  readonly autoCropEnabled = signal(true);
  /** How the "Auto" quality resolves: 'directplay' tries Direct Play first
   *  (zero transcoding when compatible), 'abr' always uses the adaptive HLS
   *  ladder. Explicit quality picks are unaffected. */
  readonly autoQualityMode = signal<'directplay' | 'abr'>('directplay');
  readonly autoQualityModes = ['directplay', 'abr'] as const;
  /** When embedded subtitles are extracted to WebVTT. Extraction reads the
   *  whole container, so this only picks where that read happens — every mode
   *  still extracts on demand for a track nobody prepared. */
  readonly subtitlePrewarm = signal<'off' | 'playback' | 'import'>('playback');
  /** Tonemap algorithms the server reports as runnable on this host.
   *  When the list has a single entry (`['auto']` — e.g. macOS, or a
   *  Linux box with no OpenCL stack and no Intel iGPU), we hide the
   *  whole row in the template: the select would carry no meaningful
   *  choice. */
  readonly tonemapAlgosAvailable = signal<string[]>(['auto']);
  /** Selected GPU render node, or 'auto' to let the backend pick. */
  readonly gpuRenderNode = signal('auto');
  /** GPU render nodes the server detected. The device-picker row in the
   *  template only shows when more than one is present — a single-GPU
   *  host has nothing to choose. */
  readonly gpus = signal<{ renderNode: string; label: string; kind: string; accel: string }[]>([]);

  async ngOnInit() {
    try {
      const [all, algos, gpusResp, effective] = await Promise.all([
        this.api.getAll(),
        this.streamingApi.getTonemapAlgos().catch(() => ({ available: ['auto'] })),
        this.streamingApi.getGpus().catch(() => ({ gpus: [], defaultNode: '' })),
        this.streamingApi.getEffectiveSettings().catch(() => null),
      ]);
      this.refreshCacheStats();
      this.segmentDuration.set(all['streaming_segment_duration'] ?? '3');
      this.qsvPreset.set(all['streaming_qsv_preset'] ?? 'faster');
      this.autoCropEnabled.set(all['streaming_auto_crop_enabled'] !== 'false');
      this.autoQualityMode.set(
        all['streaming_auto_quality_mode'] === 'abr' ? 'abr' : 'directplay',
      );
      const prewarm = all['streaming_subtitle_prewarm'];
      this.subtitlePrewarm.set(
        prewarm === 'off' || prewarm === 'import' ? prewarm : 'playback',
      );
      this.tonemapAlgosAvailable.set(algos.available ?? ['auto']);
      this.gpus.set(gpusResp.gpus ?? []);
      // Pre-fill from the resolved values, not the raw keys: an unset field
      // must show what the server actually uses, or the form would claim
      // "auto" while an env var drives the session, and saving would replace
      // an env-configured value with a default.
      const algo = effective?.tonemapAlgo ?? all['streaming_tonemap_algo'] ?? 'auto';
      // A value this host can't run (e.g. opencl after a driver change broke
      // the probe) collapses back to 'auto', or the select would show an
      // option it doesn't have.
      this.tonemapAlgo.set(
        this.tonemapAlgosAvailable().includes(algo) ? algo : 'auto',
      );
      this.gpuRenderNode.set(
        effective?.gpuRenderNode ?? all['streaming_gpu_render_node'] ?? 'auto',
      );
      if (effective) {
        this.tonemapCurve.set(effective.tonemapCurve);
        this.cacheMaxGb.set(String(effective.cacheMaxGb));
        this.cacheTtlHours.set(String(effective.cacheTtlHours));
        this.ffmpegSlots.set(effective.ffmpegSlots ? String(effective.ffmpegSlots) : '');
        this.ffmpegSlotsAuto.set(effective.ffmpegSlotsAuto);
      }
    } catch { /* interceptor */ }
    this.loading.set(false);
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        streaming_segment_duration: this.segmentDuration(),
        streaming_qsv_preset: this.qsvPreset(),
        streaming_tonemap_algo: this.tonemapAlgo(),
        streaming_tonemap_curve: this.tonemapCurve(),
        streaming_cache_max_gb: this.cacheMaxGb(),
        streaming_cache_ttl_hours: this.cacheTtlHours(),
        streaming_ffmpeg_slots: this.ffmpegSlots(),
        streaming_gpu_render_node: this.gpuRenderNode(),
        streaming_auto_quality_mode: this.autoQualityMode(),
        streaming_subtitle_prewarm: this.subtitlePrewarm(),
        streaming_auto_crop_enabled: String(this.autoCropEnabled()),
      });
      this.toast.success(this.translate.instant('settings.streaming.saved'));
    } catch { /* interceptor */ }
    this.saving.set(false);
  }

  private async refreshCacheStats() {
    this.cacheStatsLoaded.set(false);
    try {
      const stats = await this.streamsApi.transcodeCacheStats();
      this.cacheEntries.set(stats.entries);
      this.cacheBytes.set(stats.bytes);
    } catch {
      /* interceptor toasts it; the spinner still has to stop */
    } finally {
      this.cacheStatsLoaded.set(true);
    }
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
