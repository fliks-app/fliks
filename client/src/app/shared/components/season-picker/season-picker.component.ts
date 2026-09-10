import { Component, computed, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SeasonLabelPipe } from '../../../core/pipes/season-label.pipe';

/** Season numbers + episode counts: what the picker renders, and all the
 *  `season-stubs` endpoint returns. */
export interface SeasonPickerRow {
  seasonNumber: number;
  episodeCount: number;
}

/**
 * Season table with a per-row toggle and a select-all header. Shared by the
 * request modal (pick what to ask for) and the add-to-library modal (pick what
 * to monitor), which differ only in the badge wording and in which rows are
 * locked.
 */
@Component({
  selector: 'app-season-picker',
  imports: [TranslatePipe, SeasonLabelPipe],
  templateUrl: './season-picker.component.html',
})
export class SeasonPickerComponent {
  readonly seasons = input<SeasonPickerRow[]>([]);
  readonly selected = input<Set<number>>(new Set());
  readonly loading = input(false);
  /** Rows the caller forbids picking — shown ticked, toggled off, and badged
   *  with `lockedBadgeKey`. */
  readonly locked = input<Set<number>>(new Set());

  readonly selectedBadgeKey = input('discover.status_selected');
  readonly unselectedBadgeKey = input('discover.status_not_requested');
  readonly lockedBadgeKey = input('discover.already_requested');

  readonly seasonToggled = output<number>();
  readonly allToggled = output<void>();

  /** Rows the user can still pick (= total minus locked). Drives the header
   *  toggle so it reflects only the selectable rows. */
  protected readonly selectableCount = computed(() => this.seasons().length - this.locked().size);

  protected readonly allSelectableChosen = computed(
    () => this.selectableCount() > 0 && this.selected().size === this.selectableCount(),
  );

  protected toggle(seasonNumber: number) {
    if (this.locked().has(seasonNumber)) return;
    this.seasonToggled.emit(seasonNumber);
  }
}
