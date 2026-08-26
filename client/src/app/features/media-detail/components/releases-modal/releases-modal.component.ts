import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MovieRelease } from '../../media-detail-release-picker.service';
import { IndexerRosterEntry } from '../../release-search-stream.service';
import { ReleasesTableComponent } from '../releases-table/releases-table.component';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';

/** `null` is the "Tous" tab; anything else is one indexer id. */
export type ReleaseTab = number | null;

interface TabView {
  id: ReleaseTab;
  label: string;
  count: number | null;
  state: IndexerSearchStateOrAll;
}

type IndexerSearchStateOrAll = IndexerRosterEntry['state'] | 'all';

@Component({
  selector: 'app-releases-modal',
  imports: [FormsModule, TranslateModule, ReleasesTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './releases-modal.component.html',
})
export class ReleasesModalComponent {
  readonly title = input.required<string>();
  readonly releases = input<MovieRelease[]>([]);
  /** Which indexers this search queries and where each one is. Empty when the search
   *  isn't streaming — the tab strip then stays hidden. */
  readonly indexers = input<IndexerRosterEntry[]>([]);
  readonly loading = input(false);
  readonly searched = input(false);
  readonly error = input('');
  readonly emptyMessage = input('media_detail.releases_empty');
  readonly grabBusy = input<string | null>(null);
  readonly grabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(true);
  readonly grabPrefix = input('r');
  readonly showCfScore = input(true);

  readonly grab = output<{ release: MovieRelease; key: string }>();

  private readonly dismissStack = inject(DismissableStackService);
  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly closeCallback = () => this.dialogEl()?.nativeElement.close();

  readonly activeTab = signal<ReleaseTab>(null);

  /** An indexer whose tab is open can drop out of a later roster (a re-run queries a
   *  different set), which would otherwise leave the modal on an empty tab for good. */
  private readonly resetOrphanTab = effect(() => {
    const roster = this.indexers();
    const active = this.activeTab();
    if (active !== null && !roster.some((ix) => ix.id === active)) this.activeTab.set(null);
  });

  readonly tabs = computed<TabView[]>(() => {
    const roster = this.indexers();
    if (!roster.length) return [];
    const counts = new Map<number, number>();
    for (const r of this.releases()) counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1);
    return [
      { id: null, label: '', count: this.releases().length, state: 'all' as const },
      ...roster.map((ix) => ({
        id: ix.id,
        label: ix.name,
        // A pending indexer has no count to show yet; a finished one shows 0 honestly.
        count: ix.state === 'pending' ? null : (counts.get(ix.id) ?? 0),
        state: ix.state,
      })),
    ];
  });

  /** The list the table renders. "Tous" is already in the server's relevance order, and a
   *  per-indexer tab is a filter over it, so neither sorts anything client-side. */
  readonly visibleReleases = computed(() => {
    const tab = this.activeTab();
    const all = this.releases();
    return tab === null ? all : all.filter((r) => r.sourceId === tab);
  });

  /** Rows and progress coexist: the full-panel spinner is only for a search with nothing
   *  back yet. */
  readonly showSpinnerPanel = computed(() => this.loading() && this.releases().length === 0);

  showModal() {
    this.activeTab.set(null);
    const el = this.dialogEl()?.nativeElement;
    if (!el || el.open) return;
    el.showModal();
    this.dismissStack.push(this.closeCallback);
    el.addEventListener('close', () => this.dismissStack.remove(this.closeCallback), { once: true });
  }
}
