import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { QoeDiagnosis, QoeReason, StreamQoe } from '../../../core/services/api/qoe-api.service';
import { QOE_DOT_CLASS, formatMbps, qoeHealth } from '../qoe-health';

export type QoeBadgeData = QoeDiagnosis & Partial<Omit<StreamQoe, keyof QoeDiagnosis>>;

/** Health dot + verdict label, with an expandable block of the measurements behind it. */
@Component({
  selector: 'app-qoe-badge',
  imports: [TranslatePipe],
  templateUrl: './qoe-badge.html',
})
export class QoeBadgeComponent {
  private readonly translate = inject(TranslateService);

  readonly qoe = input.required<QoeBadgeData>();
  readonly open = signal(false);

  readonly dotClass = computed(() => QOE_DOT_CLASS[qoeHealth(this.qoe())]);
  readonly droppedLabel = computed(() => {
    const d = this.qoe().droppedPct;
    return d == null ? '-' : `${d.toFixed(1)} %`;
  });

  readonly mbps = formatMbps;

  reasonText(r: QoeReason): string {
    return this.translate.instant(r.key, r.params);
  }

  bufferLabel(s: number | null | undefined): string {
    return s == null ? '-' : `${s.toFixed(1)} s`;
  }
}
