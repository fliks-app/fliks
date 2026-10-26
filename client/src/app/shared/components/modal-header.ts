import { Component, booleanAttribute, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideX } from '@lucide/angular';

/** Standard dialog header: the close button submits the enclosing native <dialog>; a CSS-shown modal (no showModal()) must close on `(closed)`.
 *  The default variant bleeds out of `.modal-box` padding; `flush` is for a `p-0` box laid out as a flex column. */
@Component({
  selector: 'app-modal-header',
  imports: [TranslatePipe, LucideX],
  templateUrl: './modal-header.html',
  host: {
    class:
      'flex items-start justify-between gap-4 border-b border-base-200 bg-base-100',
    '[class]': `flush() ? 'shrink-0 px-5 sm:px-6 pt-4 pb-3' : 'modal-header-bar'`,
  },
})
export class ModalHeaderComponent {
  readonly title = input('');
  readonly flush = input(false, { transform: booleanAttribute });
  readonly closed = output<void>();
}
