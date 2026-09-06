import { Component, booleanAttribute, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Standard dialog header: title on the left, close button on the right, ruled
 * off from the body. The button submits
 * the enclosing native <dialog>, so no handler is needed. Pass a plain `title`,
 * or project a custom title area (icon, subtitle). A modal shown by CSS rather
 * than showModal() has no dialog to submit to and must close on `(closed)`.
 *
 * The default variant bleeds out of `.modal-box`'s 1.5rem padding so the rule
 * spans the full width; `flush` is for a box that already sets `p-0` and lays
 * its header, body and footer out as a flex column.
 */
@Component({
  selector: 'app-modal-header',
  imports: [TranslatePipe],
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
