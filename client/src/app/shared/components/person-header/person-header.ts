import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';
import { ClampToggleDirective } from '../../directives/clamp-toggle.directive';

/** The avatar, name and clamped biography every person page opens with; the facts go between the name and the biography, the buttons after it. */
@Component({
  selector: 'app-person-header',
  imports: [TranslatePipe, ResolveUrlPipe, CachedSrcDirective, ClampToggleDirective],
  templateUrl: './person-header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class PersonHeaderComponent {
  readonly name = input.required<string>();
  readonly avatarUrl = input<string | null>(null);
  readonly biography = input<string | null>(null);
  /** Pairs the avatar with the card that opened the page (`person-avatar-card`'s `posterName`). */
  readonly viewTransitionName = input<string | null>(null);
}
