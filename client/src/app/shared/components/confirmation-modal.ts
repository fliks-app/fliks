import {
  Component,
  inject,
  computed,
  effect,
  viewChild,
  ElementRef,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ModalHeaderComponent } from './modal-header';
import { ModalFooterComponent } from './modal-footer';

@Component({
  selector: 'app-confirmation-modal',
  imports: [ModalFooterComponent, ModalHeaderComponent, TranslatePipe],
  templateUrl: './confirmation-modal.html',
})
export class ConfirmationModalComponent {
  readonly confirmService = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly isOpen = computed(() => !!this.confirmService.state());
  readonly title = computed(() => this.confirmService.state()?.title ?? '');
  readonly message = computed(() => this.confirmService.state()?.message ?? '');
  readonly confirmLabel = computed(
    () => this.confirmService.state()?.confirmLabel ?? this.translate.instant('common.confirm'),
  );
  readonly cancelLabel = computed(
    () => this.confirmService.state()?.cancelLabel ?? this.translate.instant('common.cancel'),
  );
  readonly variant = computed(() => this.confirmService.state()?.variant ?? 'default');

  readonly alertOnly = computed(() => this.confirmService.state()?.alertOnly ?? false);
  readonly toggleLabel = computed(() => this.confirmService.state()?.toggleLabel ?? null);
  readonly toggleHint = computed(() => this.confirmService.state()?.toggleHint ?? null);
  readonly dismissLabel = computed(() => this.confirmService.state()?.dismissLabel ?? null);

  readonly confirmBtnClass = computed(() => {
    const map: Record<string, string> = {
      danger: 'btn-error',
      warning: 'btn-warning',
      info: 'btn-info',
      default: 'btn-primary',
    };
    return map[this.variant()] ?? 'btn-primary';
  });

  constructor() {
    // Open through the native dialog API so the confirmation lands in the
    // browser top layer — above any modal already opened with showModal()
    // (e.g. the subtitles modal). A CSS/z-index modal can never sit above a
    // top-layer one.
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (!el) return;
      if (this.isOpen()) {
        if (!el.open) el.showModal();
      } else if (el.open) {
        el.close();
      }
    });
  }

  /** ESC / backdrop dismissal closes the native dialog — resolve the pending
   *  request the same way the buttons would. No-op when a button already
   *  resolved it (the service calls are idempotent). */
  onDialogClose() {
    if (!this.confirmService.state()) return;
    if (this.dismissLabel()) this.confirmService.dismiss();
    else this.confirmService.cancel();
  }
}
