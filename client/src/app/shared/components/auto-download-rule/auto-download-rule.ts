import { Component, inject, input } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AutoDownloadService } from '../../../core/services/auto-download.service';
import { DropdownMenuComponent } from '../dropdown-menu';
import { DropdownOptionComponent } from '../dropdown-option/dropdown-option';

/** Per-device "keep the next N episodes" selector for one series. */
@Component({
  selector: 'app-auto-download-rule',
  imports: [TranslatePipe, DropdownMenuComponent, DropdownOptionComponent],
  templateUrl: './auto-download-rule.html',
})
export class AutoDownloadRuleComponent {
  protected readonly auto = inject(AutoDownloadService);
  private readonly translate = inject(TranslateService);
  readonly seriesId = input.required<number>();
  protected readonly options = [0, ...this.auto.KEEP_OPTIONS];

  protected label(n: number): string {
    return n ? this.translate.instant('downloads.auto_next', { count: n }) : this.translate.instant('downloads.auto_off');
  }

  protected change(n: number): void {
    this.auto.setSeriesKeep(this.seriesId(), n || null);
  }
}
