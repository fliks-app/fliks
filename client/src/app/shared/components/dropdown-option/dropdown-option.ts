import { Component, input } from '@angular/core';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/** One `app-dropdown-menu` option (optional thumbnail, head, detail, selected marker); labels arrive translated, the host is `display: contents`
 *  so `.dropdown-item`'s `w-full` resolves against the menu. Selection is the bubbled `(click)`, which also closes the menu. */
@Component({
  selector: 'app-dropdown-option',
  imports: [
    CachedSrcDirective,ResolveUrlPipe],
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
