import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy, afterNextRender, booleanAttribute, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCheck, LucideChevronLeft } from '@lucide/angular';
import { Episode, Media, MediaService, Season } from '../../../core/services/api/media.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { SeasonLabelPipe } from '../../../core/pipes/season-label.pipe';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { episodeBadgeLabel, hideShadowedEpisodes } from '../../../features/media-detail/media-detail.utils';
import { MediaCardComponent } from '../media-card/media-card';
import { ModalHeaderComponent } from '../modal-header';

export interface MediaPick {
  mediaId: number;
  episodeId: number | null;
  /** The movie's or the series' title. */
  title: string;
}

export type EpisodePickMode = 'this' | 'untilEnd' | 'season' | 'multiple';

export const SEARCH_DEBOUNCE_MS = 300;

/** A series opens to its playable episodes; a movie needs a file, which a missing or monitored one lacks. */
const pickable = (m: Media) => m.type !== 'movie' || (m.files?.length ?? m.fileCount ?? 0) > 0;

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

/** Library title picker dialog: a movie is one click, a series goes season, then episodes. Emits the picks in play order through `picked`. */
@Component({
  selector: 'app-media-picker',
  imports: [
    FormsModule,
    TranslatePipe,
    TranslatePluralPipe,
    SeasonLabelPipe,
    LucideCheck,
    LucideChevronLeft,
    ModalHeaderComponent,
    MediaCardComponent,
  ],
  templateUrl: './media-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPickerComponent implements OnDestroy {
  private readonly media = inject(MediaService);
  private readonly injector = inject(Injector);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Allows the episode modes beyond "this episode". */
  readonly multiple = input(false, { transform: booleanAttribute });
  readonly picked = output<MediaPick[]>();

  protected readonly query = signal('');
  protected readonly results = signal<Media[]>([]);
  protected readonly searched = signal(false);
  protected readonly loading = signal(false);
  protected readonly series = signal<Media | null>(null);
  protected readonly seriesLoading = signal(false);
  protected readonly seasonNumber = signal<number | null>(null);
  protected readonly mode = signal<EpisodePickMode>('this');
  /** Ticked episode ids across every season. */
  protected readonly ticked = signal<ReadonlySet<number>>(new Set());

  protected readonly modes = computed<EpisodePickMode[]>(() =>
    this.multiple() ? ['this', 'untilEnd', 'season', 'multiple'] : ['this']);
  protected readonly seasons = computed(() => pickerSeasons(this.series()?.seasons));
  protected readonly episodes = computed(() =>
    this.seasons().find((s) => s.seasonNumber === this.seasonNumber())?.episodes ?? []);
  protected readonly allEpisodes = computed(() => this.seasons().flatMap((s) => s.episodes));
  protected readonly confirmable = computed(() => this.mode() === 'season' || this.mode() === 'multiple');
  protected readonly confirmCount = computed(() => this.confirmEpisodes().length);

  private timer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;
  private chooseSeq = 0;

  show(): void {
    const el = this.dialog()?.nativeElement;
    if (!el || el.open) return;
    this.reset();
    this.query.set('');
    this.results.set([]);
    this.searched.set(false);
    this.keyboard.enter();
    el.showModal();
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
    this.loading.set(false);
    this.series.set(null);
    this.seriesLoading.set(false);
    this.seasonNumber.set(null);
    this.mode.set('this');
    this.ticked.set(new Set());
  }

  private focusView(): void {
    afterNextRender(() => this.dialog()?.nativeElement.querySelector<HTMLElement>('[autofocus]')?.focus(), { injector: this.injector });
  }

  protected modeKey(m: EpisodePickMode): string {
    return MODE_KEY[m];
  }

  protected badge(ep: Episode): string {
    return episodeBadgeLabel(ep);
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(value.trim()), SEARCH_DEBOUNCE_MS);
  }

  private async search(q: string): Promise<void> {
    const seq = ++this.searchSeq;
    if (!q) {
      this.results.set([]);
      this.searched.set(false);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      const page = await this.media.getAll({ q, limit: 24 });
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

  protected async choose(m: Media): Promise<void> {
    if (m.type !== 'series') {
      this.emit([{ mediaId: m.id, episodeId: null, title: m.title }]);
      return;
    }
    const seq = ++this.chooseSeq;
    this.seriesLoading.set(true);
    this.series.set(m);
    this.seasonNumber.set(null);
    this.mode.set('this');
    this.ticked.set(new Set());
    this.focusView();
    try {
      const full = await this.media.getOne(m.id);
      if (seq !== this.chooseSeq) return;
      this.series.set(full);
      this.seasonNumber.set(this.seasons()[0]?.seasonNumber ?? null);
    } catch {
      if (seq === this.chooseSeq) this.series.set(null);
    } finally {
      if (seq === this.chooseSeq) this.seriesLoading.set(false);
    }
  }

  protected back(): void {
    this.chooseSeq++;
    this.seriesLoading.set(false);
    this.series.set(null);
    this.focusView();
  }

  protected setMode(m: EpisodePickMode): void {
    this.mode.set(m);
    this.ticked.set(new Set());
  }

  protected onEpisode(ep: Episode): void {
    const mode = this.mode();
    if (mode === 'multiple') {
      this.ticked.update((s) => {
        const next = new Set(s);
        if (!next.delete(ep.id)) next.add(ep.id);
        return next;
      });
    } else if (mode !== 'season') {
      this.emitEpisodes(pickEpisodes(mode, this.episodes(), ep.id, this.ticked()));
    }
  }

  protected confirm(): void {
    this.emitEpisodes(this.confirmEpisodes());
  }

  private confirmEpisodes(): Episode[] {
    const mode = this.mode();
    if (mode === 'multiple') return pickEpisodes(mode, this.allEpisodes(), null, this.ticked());
    return mode === 'season' ? this.episodes() : [];
  }

  private emitEpisodes(eps: Episode[]): void {
    const series = this.series();
    if (!series || !eps.length) return;
    this.emit(eps.map((e) => ({ mediaId: series.id, episodeId: e.id, title: series.title })));
  }

  private emit(picks: MediaPick[]): void {
    this.picked.emit(picks);
    this.close();
  }
}
