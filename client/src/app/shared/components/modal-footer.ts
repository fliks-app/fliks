import {
  Component,
  booleanAttribute,
  input,
} from '@angular/core';

/** Standard dialog footer mirroring {@link ModalHeaderComponent}, `flush` included: pinned in a `p-0` box, at content end in a padded one. */
@Component({
  selector: 'app-modal-footer',
  templateUrl: './modal-footer.html',
  host: {
    class: 'modal-action border-t border-base-200 bg-base-100',
    '[class]': `flush() ? 'shrink-0 mt-0 px-5 sm:px-6 pt-3 pb-4' : 'modal-footer-bar'`,
  },
})
export class ModalFooterComponent {
  readonly flush = input(false, { transform: booleanAttribute });
}
