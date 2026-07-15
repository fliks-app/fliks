import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/**
 * Standard dialog header: title on the left, close button on the right, laid
 * out in a flex row so the button's focus ring isn't clipped by the modal-box
 * corner. The button submits the enclosing native <dialog>, so no handler is
 * needed. Pass a plain `title`, or project a custom title area (icon, subtitle).
 */
@Component({
  selector: 'app-modal-header',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './modal-header.html',
})
export class ModalHeaderComponent {
  readonly title = input('');
}
