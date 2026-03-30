import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../core/services/confirmation.service';

@Component({
  selector: 'app-confirmation-modal',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirmation-modal.html',
})
export class ConfirmationModalComponent {
  readonly confirmService = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);

  readonly isOpen = computed(() => !!this.confirmService.state());
  readonly title = computed(() => this.confirmService.state()?.title ?? '');
  readonly message = computed(() => this.confirmService.state()?.message ?? '');
  readonly confirmLabel = computed(
    () =>
      this.confirmService.state()?.confirmLabel ??
      this.translate.instant('common.confirm'),
  );
  readonly cancelLabel = computed(
    () =>
      this.confirmService.state()?.cancelLabel ??
      this.translate.instant('common.cancel'),
  );
  readonly variant = computed(
    () => this.confirmService.state()?.variant ?? 'default',
  );

  readonly confirmBtnClass = computed(() => {
    const map: Record<string, string> = {
      danger: 'btn-error',
      warning: 'btn-warning',
      info: 'btn-info',
      default: 'btn-primary',
    };
    return map[this.variant()] ?? 'btn-primary';
  });
}
