import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ClampToggleDirective } from '../../directives/clamp-toggle.directive';
import { SpoilerDirective } from '../../directives/spoiler.directive';

/** Clamped synopsis with its show-more toggle, optionally masked as a spoiler. */
@Component({
  selector: 'app-synopsis',
  imports: [TranslateModule, ClampToggleDirective, SpoilerDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './synopsis.html',
  host: { class: 'block' },
})
export class SynopsisComponent {
  readonly text = input.required<string>();
  /** Blur the text until the reader asks for it. */
  readonly spoiler = input(false);
  /** Lines kept before the show-more toggle appears. */
  readonly lines = input<3 | 4>(4);
  readonly textClass = input('');
  readonly toggleClass = input('mt-1');
}
