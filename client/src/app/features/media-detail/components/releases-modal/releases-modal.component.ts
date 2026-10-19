import {
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
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCirclePause, LucideSearchX, LucideTriangleAlert } from '@lucide/angular';
import { MovieRelease } from '../../media-detail-release-picker.service';
import { IndexerRosterEntry } from '../../release-search-stream.service';
import { ReleasesTableComponent } from '../releases-table/releases-table.component';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

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
  imports: [
    ModalFooterComponent,
    ModalHeaderComponent,
    FormsModule,
    TranslatePipe,
    ReleasesTableComponent,
    LucideSearchX,
    LucideTriangleAlert,
    LucideCirclePause,
  ],
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

  /** What the picker shows: exactly the profile's allowed qualities (above is unwanted, below no fallback); other rejections still show and confirm.
   * Filtered here, not in the row list, so a tab count never promises hidden rows. */
  private readonly offered = computed(() => this.releases().filter((r) => r.allowed));

  readonly tabs = computed<TabView[]>(() => {
    const roster = this.indexers();
    if (!roster.length) return [];
    const counts = new Map<number, number>();
    for (const r of this.offered()) counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1);
    // `count: null` is the spinner slot — a tab still working. Tous spins for as long as any
    // indexer does, so the whole strip follows one rule instead of the header carrying its own.
    return [
      {
        id: null,
        label: '',
        count: this.loading() ? null : this.offered().length,
        state: 'all' as const,
      },
      ...roster.map((ix) => ({
        id: ix.id,
        label: ix.name,
        count: ix.state === 'pending' ? null : (counts.get(ix.id) ?? 0),
        state: ix.state,
      })),
    ];
  });

  /** The list the table renders. "Tous" is already in the server's relevance order, and a
   *  per-indexer tab is a filter over it, so neither sorts anything client-side. */
  readonly visibleReleases = computed(() => {
    const tab = this.activeTab();
    const all = this.offered();
    return tab === null ? all : all.filter((r) => r.sourceId === tab);
  });

  /** The open tab has nothing *yet*: the search or this tab's indexer is still running. Rows win once present; once the search answered nothing spins. */
  readonly showSpinnerPanel = computed(() => {
    if (this.visibleReleases().length || !this.loading()) return false;
    const tab = this.activeTab();
    if (tab === null) return true;
    return this.indexers().some((ix) => ix.id === tab && ix.state === 'pending');
  });

  /** Why the open tab is empty: "found nothing" and "never answered" call for different fixes; the whole search uses the caller's message. */
  readonly emptyPanel = computed<{ icon: 'none' | 'failed' | 'skipped'; key: string }>(() => {
    const tab = this.activeTab();
    if (tab === null) return { icon: 'none', key: this.emptyMessage() };
    const state = this.indexers().find((ix) => ix.id === tab)?.state;
    if (state === 'failed') return { icon: 'failed', key: 'media_detail.indexer_failed' };
    if (state === 'skipped') return { icon: 'skipped', key: 'media_detail.indexer_cooldown' };
    return { icon: 'none', key: 'media_detail.releases_empty_indexer' };
  });

  showModal() {
    this.activeTab.set(null);
    const el = this.dialogEl()?.nativeElement;
    if (!el || el.open) return;
    el.showModal();
    this.dismissStack.push(this.closeCallback);
    el.addEventListener('close', () => this.dismissStack.remove(this.closeCallback), {
      once: true,
    });
  }
}
