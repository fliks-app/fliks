import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  input,
} from '@angular/core';

/**
 * Standard dialog footer: actions right-aligned, ruled off from the body.
 * Mirrors {@link ModalHeaderComponent}, `flush` included — in a `p-0` box the
 * flex column pins it, in a padded one it sits at the end of the content.
 */
@Component({
  selector: 'app-modal-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  host: {
    class: 'modal-action border-t border-base-200 bg-base-100',
    '[class]': `flush() ? 'shrink-0 mt-0 px-5 sm:px-6 pt-3 pb-4' : 'modal-footer-bar'`,
  },
})
export class ModalFooterComponent {
  readonly flush = input(false, { transform: booleanAttribute });
}
