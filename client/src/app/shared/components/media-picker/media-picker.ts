import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy, afterNextRender, booleanAttribute, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCheck, LucideSettings, LucideX } from '@lucide/angular';
import { Episode, Media, MediaService, SearchParams, Season } from '../../../core/services/api/media.service';
import { MetadataService, TmdbGenre } from '../../../core/services/api/metadata.service';
import { RecommendationItem, StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { SeasonLabelPipe } from '../../../core/pipes/season-label.pipe';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { episodeBadgeLabel, hideShadowedEpisodes } from '../../../features/media-detail/media-detail.utils';
import { MediaCardComponent } from '../media-card/media-card';
import { ModalHeaderComponent } from '../modal-header';
import { SynopsisComponent } from '../synopsis/synopsis';
import { ContentTypeToggleComponent } from '../search-filters/content-type-toggle';
import { DEFAULT_SORT, SearchContentType, SearchFiltersComponent, filtersEngaged, libraryFilterParams } from '../search-filters/search-filters';
import { KIND_REGISTRY, kindOfListFilter } from '../../../core/media-kinds';

export interface MediaPick {
  mediaId: number;
  episodeId: number | null;
  /** The movie's or the series' title. */
  title: string;
  /** The title's poster, for a caller that shows the picks. */
  posterUrl: string | null;
}

/** A title already in the target list, greyed out in the picker. */
export type TakenItem = Pick<MediaPick, 'mediaId' | 'episodeId'>;

/** What the details show before the full row arrives: a search hit or a suggestion. */
type PickerTitle = Pick<Media, 'id' | 'title' | 'type' | 'posterUrl'> & { year: number | null } & Partial<Omit<Media, 'year'>>;

const itemKey = (mediaId: number, episodeId: number | null) => `${mediaId}:${episodeId ?? ''}`;

export type EpisodePickMode = 'this' | 'untilEnd' | 'season' | 'multiple';

export const SEARCH_DEBOUNCE_MS = 300;

/** A series opens to its playable episodes; a movie needs a file, which a missing or monitored one lacks. */
const pickable = (m: Media) => KIND_REGISTRY[m.type].hasSeasons || (m.files?.length ?? m.fileCount ?? 0) > 0;

const MODE_KEY: Record<EpisodePickMode, string> = {
  this: 'this',
  untilEnd: 'until_end',
  season: 'season',
  multiple: 'multiple',
};

export interface PickerSeason {
  seasonNumber: number;
  episodes: Episode[];
}

/** Playable episodes of a season, in play order. */
export function playableEpisodes(season: Season | undefined): Episode[] {
  return hideShadowedEpisodes(season?.episodes ?? [])
    .filter((e) => e.hasFile)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/** Seasons with something to play, specials (season 0) last. */
export function pickerSeasons(seasons: Season[] | undefined): PickerSeason[] {
  return (seasons ?? [])
    .map((s) => ({ seasonNumber: s.seasonNumber, episodes: playableEpisodes(s) }))
    .filter((s) => s.episodes.length > 0)
    .sort((a, b) => (a.seasonNumber || Infinity) - (b.seasonNumber || Infinity));
}

/** Episodes a mode adds, in play order; `anchor` is the clicked episode, `ticked` the multi-select. */
export function pickEpisodes(mode: EpisodePickMode, episodes: Episode[], anchor: number | null, ticked: ReadonlySet<number>): Episode[] {
  switch (mode) {
    case 'this':
      return episodes.filter((e) => e.id === anchor);
    case 'untilEnd': {
      const from = episodes.findIndex((e) => e.id === anchor);
      return from < 0 ? [] : episodes.slice(from);
    }
    case 'season':
      return episodes;
    case 'multiple':
      return episodes.filter((e) => ticked.has(e.id));
  }
}

/** Library title picker dialog: a title opens to its synopsis, then a movie adds in one click and a series goes season, then episodes. Emits the picks in play order through `picked`. */
@Component({
  selector: 'app-media-picker',
  imports: [
    DecimalPipe,
    NgTemplateOutlet,
    ResolveUrlPipe,
    FormsModule,
    TranslatePipe,
    TranslatePluralPipe,
    SeasonLabelPipe,
    LucideCheck,
    LucideSettings,
    LucideX,
    ModalHeaderComponent,
    MediaCardComponent,
    SynopsisComponent,
    SearchFiltersComponent,
    ContentTypeToggleComponent,
  ],
  templateUrl: './media-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPickerComponent implements OnDestroy {
  protected readonly kinds = KIND_REGISTRY;
  private readonly media = inject(MediaService);
  private readonly metadata = inject(MetadataService);
  private readonly streaming = inject(StreamingApiService);
  private readonly injector = inject(Injector);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Allows the episode modes beyond "this episode". */
  readonly multiple = input(false, { transform: booleanAttribute });
  /** Labels the actions for the list being filled. */
  readonly verb = input<'add' | 'propose'>('add');
  /** Already in the target list: shown greyed and never picked again. */
  readonly taken = input<readonly TakenItem[]>([]);
  readonly picked = output<MediaPick[]>();

  protected readonly query = signal('');
  protected readonly contentType = signal<SearchContentType>('all');
  protected readonly genres = signal<TmdbGenre[]>([]);
  protected readonly selectedGenres = signal<ReadonlySet<number>>(new Set());
  protected readonly sort = signal(DEFAULT_SORT);
  protected readonly voteMin = signal(0);
  protected readonly yearMin = signal<number | null>(null);
  protected readonly yearMax = signal<number | null>(null);
  /** The filter panel on a narrow screen, where it folds above the results. */
  protected readonly filtersOpen = signal(false);
  protected readonly results = signal<Media[]>([]);
  protected readonly searched = signal(false);
  protected readonly loading = signal(false);
  private readonly recommendations = signal<RecommendationItem[]>([]);
  /** The title whose details are open. */
  protected readonly selected = signal<PickerTitle | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly seasonNumber = signal<number | null>(null);
  protected readonly mode = signal<EpisodePickMode>('this');
  /** Ticked episode ids across every season. */
  protected readonly ticked = signal<ReadonlySet<number>>(new Set());
  /** The clicked episode of the single-episode and from-here modes. */
  private readonly anchor = signal<number | null>(null);
  protected readonly watchedEpisodes = signal<ReadonlySet<number>>(new Set());

  protected readonly engaged = computed(() => filtersEngaged(this.selectedGenres(), this.voteMin(), this.yearMin(), this.yearMax()));
  /** No query and no filter: the viewer's library suggestions stand in for results. */
  protected readonly browsing = computed(() => !this.query().trim() && !this.engaged());
  protected readonly suggestions = computed(() => {
    const ct = this.contentType();
    return this.recommendations().filter((r) => r.media.available && (ct === 'all' || r.media.type === ct));
  });
  private readonly takenKeys = computed(() => new Set(this.taken().map((t) => itemKey(t.mediaId, t.episodeId))));
  protected readonly modes = computed<EpisodePickMode[]>(() =>
    this.multiple() ? ['this', 'untilEnd', 'season', 'multiple'] : ['this']);
  protected readonly isSeries = computed(() => {
    const m = this.selected();
    return !!m && KIND_REGISTRY[m.type].hasSeasons;
  });
  protected readonly seasons = computed(() => pickerSeasons(this.selected()?.seasons));
  protected readonly episodes = computed(() =>
    this.seasons().find((s) => s.seasonNumber === this.seasonNumber())?.episodes ?? []);
  protected readonly allEpisodes = computed(() => this.seasons().flatMap((s) => s.episodes));
  protected readonly watchedSeasons = computed(() => {
    const seen = this.watchedEpisodes();
    return new Set(this.seasons().filter((s) => s.episodes.every((e) => seen.has(e.id))).map((s) => s.seasonNumber));
  });
  /** Every episode the confirm button adds, marked in the list. */
  protected readonly chosen = computed(() => new Set(this.confirmEpisodes().map((e) => e.id)));
  protected readonly confirmCount = computed(() => this.confirmEpisodes().length);

  /** Re-runs the library query when the text or a filter changes. */
  private readonly searchEffect = effect(() => {
    const q = this.query().trim();
    const params = libraryFilterParams({
      type: this.contentType(),
      genreNames: this.genres().filter((g) => this.selectedGenres().has(g.id)).map((g) => g.name),
      sort: this.sort(),
      voteMin: this.voteMin(),
      yearMin: this.yearMin(),
      yearMax: this.yearMax(),
    });
    const browsing = this.browsing();
    untracked(() => {
      clearTimeout(this.timer);
      if (this.selected()) this.collapse();
      if (browsing) {
        this.searchSeq++;
        this.results.set([]);
        this.searched.set(false);
        this.loading.set(false);
        return;
      }
      this.timer = setTimeout(() => void this.search({ q, limit: 24, ...params }), SEARCH_DEBOUNCE_MS);
    });
  });

  /** Movie genres for "all" and "movie", the TV list for series, as on the search page. */
  private readonly genreEffect = effect(() => {
    const kind = kindOfListFilter(this.contentType());
    untracked(() => {
      const seq = ++this.genreSeq;
      this.metadata.genresByKind(kind)
        .then((g) => { if (seq === this.genreSeq) this.genres.set(g); })
        .catch(() => { if (seq === this.genreSeq) this.genres.set([]); });
    });
  });

  private timer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;
  private genreSeq = 0;
  private chooseSeq = 0;

  show(): void {
    const el = this.dialog()?.nativeElement;
    if (!el || el.open) return;
    this.reset();
    this.query.set('');
    this.filtersOpen.set(false);
    this.keyboard.enter();
    el.showModal();
    void this.streaming.getRecommendations({ limit: 30 }).then((r) => this.recommendations.set(r)).catch(() => {});
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    if (this.dialog()?.nativeElement.open) this.keyboard.leave();
  }

  protected onClosed(): void {
    this.reset();
    this.keyboard.leave();
  }

  /** Drops pending timers and in-flight responses, and returns to the search view. */
  private reset(): void {
    clearTimeout(this.timer);
    this.searchSeq++;
    this.chooseSeq++;
    this.selected.set(null);
    this.detailLoading.set(false);
    this.seasonNumber.set(null);
    this.mode.set('this');
    this.ticked.set(new Set());
    this.anchor.set(null);
  }

  /** Brings the open title into view and focuses its first action, else the search field. */
  private focusView(): void {
    afterNextRender(() => {
      const root = this.dialog()?.nativeElement;
      root?.querySelector('[data-picker-detail]')?.scrollIntoView({ block: 'nearest' });
      const target = ['[data-picker-focus]', '[data-picker-detail] button', '[autofocus]'].map((q) => root?.querySelector<HTMLElement>(q)).find(Boolean);
      target?.focus();
    }, { injector: this.injector });
  }

  protected modeKey(m: EpisodePickMode): string {
    return MODE_KEY[m];
  }

  protected badge(ep: Episode): string {
    return episodeBadgeLabel(ep);
  }

  protected isTaken(mediaId: number, episodeId: number | null): boolean {
    return this.takenKeys().has(itemKey(mediaId, episodeId));
  }

  private async search(params: SearchParams): Promise<void> {
    const seq = ++this.searchSeq;
    this.loading.set(true);
    try {
      const page = await this.media.getAll(params);
      if (seq === this.searchSeq) this.results.set(page.data.filter(pickable));
    } catch {
      if (seq === this.searchSeq) this.results.set([]);
    } finally {
      if (seq === this.searchSeq) {
        this.searched.set(true);
        this.loading.set(false);
      }
    }
  }

  /** Opens the title's details; the full row brings the synopsis and, for a series, its episodes. */
  protected async choose(m: PickerTitle): Promise<void> {
    const seq = ++this.chooseSeq;
    this.detailLoading.set(true);
    this.animateGrid(() => this.selected.set(m));
    this.watchedEpisodes.set(new Set());
    this.seasonNumber.set(null);
    this.mode.set('this');
    this.ticked.set(new Set());
    this.anchor.set(null);
    this.focusView();
    try {
      const [full, watched] = await Promise.all([
        this.media.getOne(m.id),
        KIND_REGISTRY[m.type].hasSeasons ? this.streaming.getWatchedEpisodeIds(m.id).catch(() => [] as number[]) : [],
      ]);
      if (seq !== this.chooseSeq) return;
      this.watchedEpisodes.set(new Set(watched));
      this.selected.set(full);
      this.seasonNumber.set(this.seasons()[0]?.seasonNumber ?? null);
      if (KIND_REGISTRY[full.type].hasSeasons) this.focusView();
    } catch {
      if (seq === this.chooseSeq && KIND_REGISTRY[m.type].hasSeasons) this.selected.set(null);
    } finally {
      if (seq === this.chooseSeq) this.detailLoading.set(false);
    }
  }

  protected addMovie(): void {
    const m = this.selected();
    if (m && !this.isTaken(m.id, null)) this.emit([{ mediaId: m.id, episodeId: null, title: m.title, posterUrl: m.posterUrl }]);
  }

  protected collapse(): void {
    this.chooseSeq++;
    this.detailLoading.set(false);
    this.animateGrid(() => this.selected.set(null));
  }

  /** FLIP: the poster travels between its card and the open details, and the cards slide back on close. */
  private animateGrid(change: () => void): void {
    const grid = this.dialog()?.nativeElement.querySelector('[data-picker-grid]');
    if (!grid || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      change();
      return;
    }
    const target = (el: Element) => (el.hasAttribute('data-picker-detail') ? el.querySelector('[data-picker-poster]') : el);
    const before = new Map<string, DOMRect>();
    for (const el of Array.from(grid.children)) {
      const id = (el as HTMLElement).dataset['id'];
      const t = target(el);
      if (id && t) before.set(id, t.getBoundingClientRect());
    }
    change();
    afterNextRender(() => {
      const timing = { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
      for (const el of Array.from(grid.children)) {
        const from = before.get((el as HTMLElement).dataset['id'] ?? '');
        const t = target(el);
        if (!from || !t) continue;
        const to = t.getBoundingClientRect();
        if (!to.width) continue;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        const k = from.width / to.width;
        if (!dx && !dy && k === 1) continue;
        t.animate([{ transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transformOrigin: 'top left', transform: 'none' }], timing);
      }
      grid.querySelector('[data-picker-info]')?.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, delay: 120, fill: 'backwards' });
    }, { injector: this.injector });
  }

  protected setMode(m: EpisodePickMode): void {
    this.mode.set(m);
    this.ticked.set(new Set());
    this.anchor.set(null);
  }

  protected setSeason(n: number): void {
    this.seasonNumber.set(n);
    this.anchor.set(null);
  }

  protected onEpisode(ep: Episode): void {
    const mode = this.mode();
    if (this.untaken([ep]).length === 0) return;
    if (mode === 'multiple') {
      this.ticked.update((s) => {
        const next = new Set(s);
        if (!next.delete(ep.id)) next.add(ep.id);
        return next;
      });
    } else if (mode !== 'season') {
      this.anchor.set(ep.id);
    }
  }

  protected confirm(): void {
    this.emitEpisodes(this.confirmEpisodes());
  }

  private confirmEpisodes(): Episode[] {
    const mode = this.mode();
    const episodes = mode === 'multiple' ? this.allEpisodes() : this.episodes();
    return this.untaken(pickEpisodes(mode, episodes, this.anchor(), this.ticked()));
  }

  private untaken(eps: Episode[]): Episode[] {
    const id = this.selected()?.id;
    return id == null ? [] : eps.filter((e) => !this.isTaken(id, e.id));
  }

  private emitEpisodes(eps: Episode[]): void {
    const series = this.selected();
    if (!series || !eps.length) return;
    this.emit(eps.map((e) => ({ mediaId: series.id, episodeId: e.id, title: series.title, posterUrl: series.posterUrl })));
  }

  private emit(picks: MediaPick[]): void {
    this.picked.emit(picks);
    this.close();
  }
}
