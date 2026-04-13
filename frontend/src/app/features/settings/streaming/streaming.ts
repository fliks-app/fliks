import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-streaming-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './streaming.html',
})
export class StreamingSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly saving = signal(false);

  readonly segmentFormat = signal('auto');
  readonly segmentDuration = signal('3');
  readonly initTime = signal('1');
  readonly qsvPreset = signal('faster');
  readonly qsvLookahead = signal(false);
  readonly qsvLowPower = signal(false);
  readonly qsvAdaptive = signal(true);

  async ngOnInit() {
    try {
      const all = await this.api.getAll();
      this.segmentFormat.set(all['streaming_segment_format'] ?? 'auto');
      this.segmentDuration.set(all['streaming_segment_duration'] ?? '3');
      this.initTime.set(all['streaming_init_time'] ?? '1');
      this.qsvPreset.set(all['streaming_qsv_preset'] ?? 'faster');
      this.qsvLookahead.set(all['streaming_qsv_lookahead'] === 'true');
      this.qsvLowPower.set(all['streaming_qsv_low_power'] === 'true');
      // Default true when the key is absent.
      this.qsvAdaptive.set(
        all['streaming_qsv_adaptive'] == null
          ? true
          : all['streaming_qsv_adaptive'] === 'true',
      );
    } catch { /* interceptor */ }
    this.loading.set(false);
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        streaming_segment_format: this.segmentFormat(),
        streaming_segment_duration: this.segmentDuration(),
        streaming_init_time: this.initTime(),
        streaming_qsv_preset: this.qsvPreset(),
        streaming_qsv_lookahead: String(this.qsvLookahead()),
        streaming_qsv_low_power: String(this.qsvLowPower()),
        streaming_qsv_adaptive: String(this.qsvAdaptive()),
      });
      this.toast.success(this.translate.instant('settings.streaming.saved'));
    } catch { /* interceptor */ }
    this.saving.set(false);
  }
}
