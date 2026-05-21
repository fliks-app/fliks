import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideCheck,
  LucideChevronRight,
  LucideCircleAlert,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import {
  ChecklistItem,
  ChecklistItemKey,
  SetupChecklistApiService,
} from '../../../core/services/api/setup-checklist-api.service';

@Component({
  selector: 'app-setup-checklist',
  imports: [
    RouterLink,
    TranslateModule,
    LucideCheck,
    LucideChevronRight,
    LucideCircleAlert,
    LucideTriangleAlert,
    LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup-checklist.html',
})
export class SetupChecklistComponent implements OnInit {
  private readonly api = inject(SetupChecklistApiService);

  /** When `true`, also surface completed and dismissed items (with a
   *  reactivate button on the latter). Off by default — the home
   *  widget only wants pending things. */
  readonly showAll = input(false);

  readonly items = this.api.items;
  readonly loading = this.api.loading;

  /** Items shown in the list. Compact mode (default) keeps only the
   *  pending, non-dismissed ones — those are the user's TODO. */
  readonly visibleItems = computed(() => {
    const all = this.items();
    if (this.showAll()) return all;
    return all.filter((i) => !i.done && !i.dismissed);
  });

  /** Severity counters used by the header badge. */
  readonly pendingRequiredCount = computed(
    () =>
      this.items().filter(
        (i) => i.severity === 'required' && !i.done && !i.dismissed,
      ).length,
  );
  readonly pendingRecommendedCount = computed(
    () =>
      this.items().filter(
        (i) => i.severity === 'recommended' && !i.done && !i.dismissed,
      ).length,
  );

  ngOnInit() {
    // Reuse already-cached items on second mount; otherwise fetch.
    if (this.items().length === 0) void this.api.refresh();
  }

  onDismiss(key: ChecklistItemKey, event: Event) {
    event.stopPropagation();
    void this.api.dismiss(key);
  }

  onUndismiss(key: ChecklistItemKey, event: Event) {
    event.stopPropagation();
    void this.api.undismiss(key);
  }

  /** Used by *@for track* to keep DOM stable across refreshes. */
  trackByKey(_: number, item: ChecklistItem) {
    return item.key;
  }
}
