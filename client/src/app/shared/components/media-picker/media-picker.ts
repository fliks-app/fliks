import { ChangeDetectionStrategy, Component, booleanAttribute, ElementRef, OnDestroy, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideChevronLeft } from '@lucide/angular';
import { Episode, Media, MediaService, Season } from '../../../core/services/api/media.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { hideShadowedEpisodes } from '../../../features/media-detail/media-detail.utils';
import { DefaultFocusDirective } from '../../directives/default-focus.directive';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { MediaCardComponent } from '../media-card/media-card';
import { ModalHeaderComponent } from '../modal-header';
import { SeasonPickerComponent } from '../season-picker/season-picker.component';

export interface MediaPick {
  mediaId: number;
  episodeId: number | null;
}

export type EpisodePickMode = 'this' | 'untilEnd' | 'season' | 'multiple';

export const SEARCH_DEBOUNCE_MS = 300;

/** Playable episodes of a season, in play order. */
export function playableEpisodes(season: Season | undefined): Episode[] {
  return hideShadowedEpisodes(season?.episodes ?? [])
    .filter((e) => e.hasFile)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
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
    LucideChevronLeft,
    ModalHeaderComponent,
    MediaCardComponent,
    SeasonPickerComponent,
    TvSectionDirective,
    TvRowDirective,
    DefaultFocusDirective,
  ],
  templateUrl: './media-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPickerComponent implements OnDestroy {
  private readonly media = inject(MediaService);
  private readonly keyboard = inject(KeyboardOverlayService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Allows the "several episodes" mode; otherwise only "this episode" is offered. */
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
  protected readonly ticked = signal<ReadonlySet<number>>(new Set());

  protected readonly modes = computed<EpisodePickMode[]>(() =>
    this.multiple() ? ['this', 'untilEnd', 'season', 'multiple'] : ['this']);
  protected readonly seasons = computed(() =>
    (this.series()?.seasons ?? [])
      .map((s) => ({ seasonNumber: s.seasonNumber, episodeCount: playableEpisodes(s).length }))
      .filter((s) => s.episodeCount > 0)
      .sort((a, b) => a.seasonNumber - b.seasonNumber));
  protected readonly selectedSeason = computed(() => new Set(this.seasonNumber() == null ? [] : [this.seasonNumber()!]));
  protected readonly episodes = computed(() =>
    playableEpisodes(this.series()?.seasons?.find((s) => s.seasonNumber === this.seasonNumber())));
  protected readonly confirmable = computed(() => this.mode() === 'season' || this.mode() === 'multiple');
  protected readonly confirmCount = computed(() =>
    pickEpisodes(this.mode(), this.episodes(), null, this.ticked()).length);

  private timer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;

  show(): void {
    clearTimeout(this.timer);
    this.query.set('');
    this.results.set([]);
    this.searched.set(false);
    this.series.set(null);
    this.keyboard.enter();
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  protected onClosed(): void {
    clearTimeout(this.timer);
    this.keyboard.leave();
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
      if (seq === this.searchSeq) this.results.set(page.data);
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
      this.emit([{ mediaId: m.id, episodeId: null }]);
      return;
    }
    this.seriesLoading.set(true);
    this.series.set(m);
    try {
      const full = await this.media.getOne(m.id);
      this.series.set(full);
      this.mode.set('this');
      this.ticked.set(new Set());
      this.seasonNumber.set(this.seasons()[0]?.seasonNumber ?? null);
    } catch {
      this.series.set(null);
    } finally {
      this.seriesLoading.set(false);
    }
  }

  protected selectSeason(n: number): void {
    this.seasonNumber.set(n);
    this.ticked.set(new Set());
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
    this.emitEpisodes(pickEpisodes(this.mode(), this.episodes(), null, this.ticked()));
  }

  private emitEpisodes(eps: Episode[]): void {
    const id = this.series()?.id;
    if (id == null || !eps.length) return;
    this.emit(eps.map((e) => ({ mediaId: id, episodeId: e.id })));
  }

  private emit(picks: MediaPick[]): void {
    this.picked.emit(picks);
    this.close();
  }
}
