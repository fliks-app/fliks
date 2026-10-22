import { Component, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AutoDownloadService } from '../../../core/services/auto-download.service';

/** Per-device "keep the next N episodes" selector for one series. */
@Component({
  selector: 'app-auto-download-rule',
  imports: [TranslatePipe],
  templateUrl: './auto-download-rule.html',
})
export class AutoDownloadRuleComponent {
  protected readonly auto = inject(AutoDownloadService);
  readonly seriesId = input.required<number>();

  protected change(value: string): void {
    this.auto.setSeriesKeep(this.seriesId(), Number(value) || null);
  }
}
