import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { QoeDiagnosis, StreamQoe } from '../../../core/services/api/qoe-api.service';
import { formatMbps, qoeDotClass } from '../qoe-health';
import { QOE_CAUSE_DOT_CLASS, translateFmt } from '../qoe-stall';

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

  private readonly fmt = translateFmt(this.translate);

  readonly dotClass = computed(() => qoeDotClass(this.qoe()));
  readonly causeDot = QOE_CAUSE_DOT_CLASS;

  mbps(bps: number | null | undefined): string {
    return formatMbps(bps, this.fmt);
  }

  pct(v: number | null | undefined): string {
    return v == null ? '-' : `${this.fmt.n(v, 1)} %`;
  }

  seconds(s: number | null | undefined): string {
    return s == null ? '-' : this.fmt.t('qoe.seconds', { value: this.fmt.n(s, 1) });
  }

  speed(v: number): string {
    return this.fmt.t('qoe.speed', { value: this.fmt.n(v, 1) });
  }

  reasonText(key: string): string {
    return this.translate.instant(key);
  }
}
