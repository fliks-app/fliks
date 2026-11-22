import { Component, ElementRef, booleanAttribute, effect, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SheetDrag, sheetDurationMs } from './sheet-drag';

const PHONE = '(max-width: 639.98px)';

/** A native `<dialog>` with its box and backdrop: centred on wide screens, a bottom sheet dismissed by a pull-down on phones. */
@Component({
  selector: 'dialog[appModal]',
  imports: [TranslatePipe],
  templateUrl: './modal.html',
  host: {
    class: 'modal modal-sheet',
    '(close)': 'onClose()',
  },
})
export class ModalComponent {
  readonly boxClass = input('');
  /** Fixed-height box whose content scrolls its own regions; header and footer stay put. */
  readonly fill = input(false, { transform: booleanAttribute });
  /** Opens or closes from state; a user close still emits `(close)`, which must clear that state. */
  readonly shown = input<boolean>();

  private readonly dialog = inject<ElementRef<HTMLDialogElement>>(ElementRef).nativeElement;
  protected readonly drag = new SheetDrag();
  private active = false;

  constructor() {
    effect(() => {
      const shown = this.shown();
      if (shown && !this.dialog.open) this.dialog.showModal();
      else if (shown === false && this.dialog.open) this.dialog.close();
    });
  }

  /** For template refs (`#dlg` resolves to this component, not the `<dialog>`). */
  close() {
    this.dialog.close();
  }

  protected onTouchStart(e: TouchEvent, box: HTMLElement) {
    // A dialog declared inside this one bubbles its touches here: only touches on this box drag it.
    this.active = matchMedia(PHONE).matches && e.target instanceof Element && e.target.closest('.modal-box') === box;
    if (!this.active) return;
    // A scrolling box carries its grip and header away, so only a pinned (`fill`) header drags.
    const fromHandle = this.fill() && e.target instanceof Element && !!e.target.closest('[data-sheet-handle], app-modal-header');
    this.drag.start(e, box, fromHandle);
  }

  protected onTouchMove(e: TouchEvent, box: HTMLElement) {
    if (this.active) this.drag.move(e, box);
  }

  protected onTouchEnd() {
    if (this.drag.end()) this.dialog.close();
  }

  /** The pulled offset stays applied until the slide-out ends, so the sheet leaves from where it was let go. */
  protected onClose() {
    setTimeout(() => this.drag.reset(), sheetDurationMs(this.dialog));
  }
}
