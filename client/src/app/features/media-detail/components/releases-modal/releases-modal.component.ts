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
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { Want } from '../../../../core/services/api/wants-api.service';
import { localizeLanguage } from '../../../../core/utils/language.utils';
import { LucideCirclePause, LucideSearchX, LucideTriangleAlert } from '@lucide/angular';
import { MovieRelease } from '../../media-detail-release-picker.service';
import { IndexerRosterEntry, sourceKey } from '../../release-search-stream.service';
import { ReleasesTableComponent } from '../releases-table/releases-table.component';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

/** `null` is the "Tous" tab; anything else is one source key (`pluginId:sourceId`). */
export type ReleaseTab = string | null;

interface TabView {
  id: ReleaseTab;
  label: string;
  /** The provider's name, set on the first tab of each provider when several are searched. */
  group: string | null;
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

  /** The wants the search can aim at; with more than one, the modal offers the choice. */
  readonly wants = input<readonly Want[]>([]);
  readonly wantFamily = input<string | null>(null);
  readonly wantLanguage = input<string | null>(null);

  readonly grab = output<{ release: MovieRelease; key: string }>();
  readonly wantChange = output<Want>();

  private readonly translate = inject(TranslateService);

  wantLabel(w: Want): string {
    const language = w.language ? localizeLanguage(w.language, this.translate) : this.translate.instant('wants.any_language');
    return `${this.translate.instant('families.' + w.family)} · ${language}`;
  }

  isSelectedWant(w: Want): boolean {
    return w.family === this.wantFamily() && (w.language ?? null) === (this.wantLanguage() ?? null);
  }

  private readonly dismissStack = inject(DismissableStackService);
  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly closeCallback = () => this.dialogEl()?.nativeElement.close();

  readonly activeTab = signal<ReleaseTab>(null);

  /** An indexer whose tab is open can drop out of a later roster (a re-run queries a
   *  different set), which would otherwise leave the modal on an empty tab for good. */
  private readonly resetOrphanTab = effect(() => {
    const roster = this.indexers();
    const active = this.activeTab();
    if (active !== null && !roster.some((ix) => sourceKey(ix.pluginId, ix.id) === active)) this.activeTab.set(null);
  });

  /** What the picker shows: exactly the profile's allowed qualities (above is unwanted, below no fallback); other rejections still show and confirm.
   * Filtered here, not in the row list, so a tab count never promises hidden rows. */
  private readonly offered = computed(() => this.releases().filter((r) => r.allowed));

  readonly tabs = computed<TabView[]>(() => {
    const roster = this.indexers();
    if (!roster.length) return [];
    const counts = new Map<string, number>();
    for (const r of this.offered()) {
      const k = sourceKey(r.pluginId, r.sourceId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const several = new Set(roster.map((ix) => ix.pluginId)).size > 1;
    let lastGroup: string | undefined;
    // `count: null` is the spinner slot — a tab still working. Tous spins for as long as any
    // indexer does, so the whole strip follows one rule instead of the header carrying its own.
    return [
      {
        id: null,
        label: '',
        group: null,
        count: this.loading() ? null : this.offered().length,
        state: 'all' as const,
      },
      ...roster.map((ix) => {
        const id = sourceKey(ix.pluginId, ix.id);
        const first = several && ix.pluginId !== lastGroup;
        lastGroup = ix.pluginId;
        return {
          id,
          label: ix.name,
          group: first ? (ix.pluginName ?? ix.pluginId ?? null) : null,
          count: ix.state === 'pending' ? null : (counts.get(id) ?? 0),
          state: ix.state,
        };
      }),
    ];
  });

  /** The list the table renders. "Tous" is already in the server's relevance order, and a
   *  per-indexer tab is a filter over it, so neither sorts anything client-side. */
  readonly visibleReleases = computed(() => {
    const tab = this.activeTab();
    const all = this.offered();
    return tab === null ? all : all.filter((r) => sourceKey(r.pluginId, r.sourceId) === tab);
  });

  /** The open tab has nothing *yet*: the search or this tab's indexer is still running. Rows win once present; once the search answered nothing spins. */
  readonly showSpinnerPanel = computed(() => {
    if (this.visibleReleases().length || !this.loading()) return false;
    const tab = this.activeTab();
    if (tab === null) return true;
    return this.indexers().some((ix) => sourceKey(ix.pluginId, ix.id) === tab && ix.state === 'pending');
  });

  /** Why the open tab is empty: "found nothing" and "never answered" call for different fixes; the whole search uses the caller's message. */
  readonly emptyPanel = computed<{ icon: 'none' | 'failed' | 'skipped'; key: string }>(() => {
    const tab = this.activeTab();
    if (tab === null) return { icon: 'none', key: this.emptyMessage() };
    const state = this.indexers().find((ix) => sourceKey(ix.pluginId, ix.id) === tab)?.state;
    if (state === 'failed') return { icon: 'failed', key: 'media_detail.indexer_failed' };
    if (state === 'skipped') return { icon: 'skipped', key: 'media_detail.indexer_cooldown' };
    return { icon: 'none', key: 'media_detail.releases_empty_indexer' };
  });

  close() {
    this.dialogEl()?.nativeElement.close();
  }

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
