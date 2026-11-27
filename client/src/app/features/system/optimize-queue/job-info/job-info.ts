import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { OptimizeService } from '../../../../core/services/api/optimize.service';
import {
  groupedChanges,
  jobDevice,
  savedBytes,
  trackOrdinal,
  warningLine,
  type OptimizeJob,
  type OptimizeJobDetail,
} from '../../../../core/models/optimize';
import type { MediaFileInfo } from '../../../../core/services/api/media.service';
import { formatBytes, formatPercent } from '../../../../core/utils/format-bytes';
import { formatAudioLabel, formatSubtitleLabel } from '../../../../core/utils/player.utils';
import { formatEta } from '../../../../shared/utils/download-format';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';

const COPY_REASONS = ['unsupported_source', 'low_savings', 'too_slow'];

type Probe = MediaFileInfo & { formatName?: string };

/** One side of the before/after table. */
interface Side {
  container: string;
  video: string;
  audio: string[];
  subtitles: string[];
}

/** What an optimize job does to its file: the planned changes, the sizes and the probes before and after. */
@Component({
  selector: 'app-optimize-job-info',
  imports: [DatePipe, TranslatePipe, ModalHeaderComponent],
  templateUrl: './job-info.html',
})
export class OptimizeJobInfoComponent {
  private readonly api = inject(OptimizeService);
  private readonly translate = inject(TranslateService);

  readonly job = input.required<OptimizeJob>();
  readonly detail = signal<OptimizeJobDetail | null>(null);
  readonly failed = signal(false);

  readonly formatBytes = formatBytes;
  readonly jobDevice = jobDevice;

  readonly saved = computed(() => {
    const j = this.job();
    const s = savedBytes(j);
    return s == null || !j.inSize ? null : { bytes: s, pct: Math.round((s / j.inSize) * 100) };
  });
  readonly changes = computed(() => {
    const d = this.detail();
    return d?.diff ? groupedChanges(d.diff.changes, trackOrdinal(d.source)) : [];
  });
  readonly warnings = computed(() => this.detail()?.diff?.warnings.map(warningLine) ?? []);
  readonly copyReason = computed(() => {
    const r = this.detail()?.copyReason;
    return r && COPY_REASONS.includes(r) ? `optimize.queue.info.copy_reason.${r}` : null;
  });
  /** Change of the video size: what the encode reached and what its test encode predicted. */
  readonly videoSize = computed(() => {
    const d = this.detail();
    if (!d || (d.savingsPct == null && d.sampledSavingsPct == null)) return null;
    const signed = (saved: number | null) => (saved == null ? null : formatPercent(-saved / 100, 0, true));
    return { real: signed(d.savingsPct), test: signed(d.sampledSavingsPct) };
  });
  readonly fidelity = computed(() => {
    const s = this.detail()?.ssim;
    return s == null ? null : formatPercent(s, 1);
  });
  /** Wall time from the lease to the encoded output. */
  readonly encodeTime = computed(() => {
    const d = this.detail();
    if (!d?.startedAt || !d.encodedAt) return null;
    const s = (new Date(d.encodedAt).getTime() - new Date(d.startedAt).getTime()) / 1000;
    return s > 0 ? formatEta(Math.round(s)) : null;
  });
  readonly before = computed(() => this.side(this.detail()?.source));
  readonly after = computed(() => this.side(this.detail()?.output));

  constructor() {
    effect((onCleanup) => {
      const id = this.job().id;
      let live = true;
      onCleanup(() => (live = false));
      this.detail.set(null);
      this.failed.set(false);
      this.api.job(id).then(
        (d) => live && this.detail.set(d),
        () => live && this.failed.set(true),
      );
    });
  }

  private side(p: Probe | null | undefined): Side | null {
    if (!p) return null;
    const v = p.video[0];
    const video = v
      ? [
          v.codec.toUpperCase(),
          v.width && v.height ? `${v.width}×${v.height}` : '',
          v.bitDepth ? `${v.bitDepth} bit` : '',
          v.hdrFormat ?? '',
          p.formatBitRate ? `${(p.formatBitRate / 1e6).toFixed(1)} Mb/s` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    return {
      container: (p.formatName ?? '').split(',')[0].toUpperCase(),
      video,
      audio: p.audio.map((a, i) => formatAudioLabel(a, this.translate, i + 1)),
      subtitles: p.subtitles.map((s, i) =>
        formatSubtitleLabel(s, this.translate, i + 1, { showFormat: true }),
      ),
    };
  }
}
