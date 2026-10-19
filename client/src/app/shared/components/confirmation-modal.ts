import {
  Component,
  inject,
  computed,
  effect,
  viewChild,
  linkedSignal,
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

  /** Last non-null state, so the content survives the closing animation. */
  private readonly view = linkedSignal<
    ReturnType<ConfirmationService['state']>,
    ReturnType<ConfirmationService['state']>
  >({
    source: this.confirmService.state,
    computation: (state, previous) => state ?? previous?.value ?? null,
  });

  readonly title = computed(() => this.view()?.title ?? '');
  readonly message = computed(() => this.view()?.message ?? '');
  readonly confirmLabel = computed(
    () => this.view()?.confirmLabel ?? this.translate.instant('common.confirm'),
  );
  readonly cancelLabel = computed(
    () => this.view()?.cancelLabel ?? this.translate.instant('common.cancel'),
  );
  readonly variant = computed(() => this.view()?.variant ?? 'default');

  readonly alertOnly = computed(() => this.view()?.alertOnly ?? false);
  readonly monospace = computed(() => this.view()?.monospace ?? false);
  readonly toggleLabel = computed(() => this.view()?.toggleLabel ?? null);
  readonly toggleHint = computed(() => this.view()?.toggleHint ?? null);
  readonly dismissLabel = computed(() => this.view()?.dismissLabel ?? null);

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
    // Open via the native dialog API: the top layer sits above any showModal() dialog, which a z-index modal never can.
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

  /** ESC/backdrop closes the native dialog: resolve the pending request like the buttons (idempotent, so a no-op if one already did). */
  onDialogClose() {
    if (!this.confirmService.state()) return;
    if (this.dismissLabel()) this.confirmService.dismiss();
    else this.confirmService.cancel();
  }
}
