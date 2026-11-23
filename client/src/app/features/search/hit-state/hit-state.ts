import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../shared/icons';
import type { RowState } from '../music-rows';

/** The one glyph of a result, in a fixed 44px slot so a state change never moves the row. */
@Component({
  selector: 'app-hit-state',
  imports: [TranslatePipe, LucideDynamicIcon],
  templateUrl: './hit-state.html',
  host: { class: 'flex size-11 shrink-0 items-center justify-center' },
})
export class HitStateComponent {
  protected readonly icons = icons;

  readonly state = input.required<RowState>();
  /** The viewer can add or request: without it the `+` is not drawn. */
  readonly canAct = input(false);
  /** An admin adds, anyone else requests. */
  readonly admin = input(false);
  readonly add = output<void>();
}
