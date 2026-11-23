import {
  Component,
  computed,
  inject,
  input,
  OnInit,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { TvService } from '../../../core/services/tv.service';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import {
  ChecklistItem,
  ChecklistItemKey,
  SetupChecklistApiService,
} from '../../../core/services/api/setup-checklist-api.service';

@Component({
  selector: 'app-setup-checklist',
  imports: [
    RouterLink,
    TranslatePipe, LucideDynamicIcon],
  templateUrl: './setup-checklist.html',
  host: { '[class.hidden]': '!shown()' },
})
export class SetupChecklistComponent implements OnInit {
  protected readonly icons = icons;

  private readonly api = inject(SetupChecklistApiService);
  /** Off on TV entirely: a server-setup surface whose every step links into the
   *  admin pages, which the 10-foot UI was never designed for. */
  protected readonly isTv = inject(TvService).isTv;

  /** When `true`, also surface completed and dismissed items (with a reactivate button on the latter). */
  readonly showAll = input(false);

  private readonly auth = inject(AuthService);

  /** The catalogue step links to an admin-only page, so a settings-access user who is no admin never sees it. */
  readonly items = computed(() =>
    this.auth.user()?.isAdmin ? this.api.items() : this.api.items().filter((i) => i.key !== 'download-provider'),
  );
  readonly loading = this.api.loading;

  /** Items shown in the list. Compact mode (default) keeps only the
   *  pending, non-dismissed ones — those are the user's TODO. */
  readonly visibleItems = computed(() => {
    const all = this.items();
    if (this.showAll()) return all;
    return all.filter((i) => !i.done && !i.dismissed);
  });

  protected readonly shown = computed(
    () => !this.isTv() && (this.visibleItems().length > 0 || (this.showAll() && this.items().length > 0)),
  );

  /** Severity counters used by the header badge. */
  readonly pendingRequiredCount = computed(
    () =>
      this.items().filter(
        (i) => i.severity === 'required' && !i.done && !i.dismissed,
      ).length,
  );
  /** Rows not dismissed, and how many of them are done. */
  readonly openCount = computed(() => this.items().filter((i) => !i.dismissed).length);
  readonly doneCount = computed(() => this.items().filter((i) => !i.dismissed && i.done).length);

  padding = input(false);

  ngOnInit() {
    // The template renders nothing on a TV, so the request could only ever be
    // discarded, on the slowest network path in the product.
    if (this.isTv()) return;
    // Reuse already-cached items on second mount; otherwise fetch.
    if (this.api.items().length === 0) void this.api.refresh();
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
