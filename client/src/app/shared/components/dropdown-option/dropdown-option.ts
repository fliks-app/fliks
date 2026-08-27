import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/**
 * One option of an `app-dropdown-menu`: an optional thumbnail, a head line, an
 * optional detail line, and the selected marker. Shared by the audio, subtitle
 * and season pickers; only the season picker carries artwork, so the thumbnail
 * reserves no space when `imageUrl` is absent.
 *
 * Both labels arrive already translated — the component holds no user-facing
 * string of its own. The host is `display: contents` so `.dropdown-item`'s
 * `w-full` keeps resolving against the menu, not against a wrapper.
 *
 * Selection is reported by binding `(click)` on the element: the inner button's
 * event bubbles through, which is also how the menu closes itself.
 */
@Component({
  selector: 'app-dropdown-option',
  imports: [
    CachedSrcDirective,ResolveUrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dropdown-option.html',
  host: { class: 'contents' },
})
export class DropdownOptionComponent {
  readonly head = input.required<string>();
  readonly sub = input<string | null | undefined>(null);
  readonly selected = input(false);
  /** Portrait artwork shown at the left of the row. Omit for a text-only option. */
  readonly imageUrl = input<string | null | undefined>(null);
}
