import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { QoeDiagnosis, StreamQoe } from '../../../core/services/api/qoe-api.service';
import { formatMbps, qoeDotClass } from '../qoe-health';
import { QOE_CAUSE_DOT_CLASS } from '../qoe-stall';

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

  readonly dotClass = computed(() => qoeDotClass(this.qoe()));
  readonly droppedLabel = computed(() => {
    const d = this.qoe().droppedPct;
    return d == null ? '-' : `${d.toFixed(1)} %`;
  });

  readonly mbps = formatMbps;
  readonly causeDot = QOE_CAUSE_DOT_CLASS;

  reasonText(key: string): string {
    return this.translate.instant(key);
  }

  bufferLabel(s: number | null | undefined): string {
    return s == null ? '-' : `${s.toFixed(1)} s`;
  }
}
