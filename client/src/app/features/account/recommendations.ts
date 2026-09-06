import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideRotateCcw } from '@lucide/angular';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * Account → Recommendations: lets the user undo every previous "Retirer de
 * cette liste" gesture. The dismissed list is otherwise hidden — without
 * this surface they had no way to bring those titles back.
 */
@Component({
  selector: 'app-account-recommendations',
  imports: [TranslatePipe, LucideRotateCcw],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recommendations.html',
})
export class AccountRecommendationsComponent implements OnInit {
  private readonly api = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly count = signal<number | null>(null);
  readonly resetting = signal(false);

  ngOnInit() {
    void this.refreshCount();
  }

  private async refreshCount() {
    try {
      const res = await this.api.countDismissedRecommendations();
      this.count.set(res.count);
    } catch {
      this.count.set(0);
    }
  }

  async reset() {
    if (!(this.count() ?? 0)) return;
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('account_settings.recommendations.confirm_title'),
      message: this.translate.instant('account_settings.recommendations.confirm_body', {
        n: this.count() ?? 0,
      }),
      confirmLabel: this.translate.instant('account_settings.recommendations.reset'),
    });
    if (!ok) return;
    this.resetting.set(true);
    try {
      const res = await this.api.resetDismissedRecommendations();
      this.toast.success(
        this.translate.instant('account_settings.recommendations.reset_success', {
          n: res.removed,
        }),
      );
      this.count.set(0);
    } catch {
      /* error handled by global interceptor */
    } finally {
      this.resetting.set(false);
    }
  }
}
