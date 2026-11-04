import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../../core/services/auth.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { PlaybackQueueService } from '../../../core/services/playback-queue.service';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookFormatFamily, CollectionDetail } from '../../../core/services/api/books.models';
import { mediaDetailLink } from '../../../core/media-kinds';
import type { Media } from '../../../core/services/api/media.service';
import { remainingLabel } from '../../../core/utils/player.utils';
import { DetailHeroComponent } from '../../../shared/components/detail-hero/detail-hero';
import { BookChaptersComponent } from './book-chapters.component';
import { BookEditionsComponent } from './book-editions.component';
import { asBookMedia } from './book-media';
import { BookSourcesComponent } from './book-sources.component';
import { BookWantsComponent } from './book-wants.component';
import { BookWorksRowComponent, type WorkItem } from './book-works-row.component';

const UNOFFICIAL_PROVIDERS = ['audible', 'audnexus'];

function toItem(e: CollectionDetail['entries'][number]): WorkItem {
  return {
    id: e.media.id,
    title: e.media.title,
    posterUrl: e.media.posterUrl,
    label: e.positionLabel ?? (e.position != null ? String(e.position) : null),
    progressPercent: e.media.progressPercent,
  };
}

/** The page of a book work, rendered by the media detail page for the `book` kind. */
@Component({
  selector: 'app-book-work',
  imports: [
    RouterLink,
    TranslatePipe,
    DetailHeroComponent,
    BookEditionsComponent,
    BookChaptersComponent,
    BookWorksRowComponent,
    BookSourcesComponent,
    BookWantsComponent,
  ],
  templateUrl: './book-work.component.html',
  host: { class: 'block' },
})
export class BookWorkComponent {
  /** The card handoff (list shape) until the full book lands. */
  readonly media = input.required<Media>();

  private readonly api = inject(BooksApiService);
  private readonly auth = inject(AuthService);
  private readonly audio = inject(AudioPlayerService);
  private readonly queue = inject(PlaybackQueueService);
  private readonly translate = inject(TranslateService);

  protected readonly book = computed(() => asBookMedia(this.media())?.book ?? null);
  protected readonly canEdit = computed(() => this.auth.hasPermission('media.edit'));
  protected readonly link = (id: number) => mediaDetailLink('book', id);

  /** The family last read or listened to, else the first edition that has a file. */
  protected readonly families = computed<BookFormatFamily[]>(() => {
    const { editions, progress } = this.book() ?? { editions: [], progress: null };
    const lead = editions.find((e) => e.id === progress?.editionId) ?? editions.find((e) => e.hasFile) ?? editions[0];
    const all = [...new Set(editions.map((e) => e.family))];
    return lead ? [lead.family, ...all.filter((f) => f !== lead.family)] : [];
  });

  /** The reader route of the text edition last read, else the first readable one. */
  protected readonly readLink = computed(() => {
    const { editions, progress } = this.book() ?? { editions: [], progress: null };
    const readable = editions.filter(
      (e) => e.family === 'text' && e.itemId != null && e.fileIds.length && ['epub', 'pdf'].includes(e.format ?? ''),
    );
    const e = readable.find((x) => x.id === progress?.editionId) ?? readable[0];
    return e ? ['/read', this.media().id, e.itemId] : null;
  });

  protected readonly narrators = computed(() => [
    ...new Map((this.book()?.editions ?? []).flatMap((e) => e.narrators).map((n) => [n.id, n])).values(),
  ]);

  protected readonly percent = computed(() => {
    const p = this.book()?.progress;
    return p ? Math.round(p.progression * 100) : null;
  });

  /** Time left for an audio edition, the percentage for a text one. */
  protected readonly progressLabel = computed(() => {
    const b = this.book();
    const p = b?.progress;
    if (!p) return null;
    const edition = b.editions.find((e) => e.id === p.editionId);
    if (edition?.family === 'audio' && edition.durationSeconds) {
      return remainingLabel(edition.durationSeconds * (1 - p.progression), this.translate);
    }
    return this.translate.instant('books_work.progress', { percent: this.percent() });
  });

  /** Whether the viewer is mid-way through this family's edition. */
  protected continues(family: BookFormatFamily): boolean {
    const p = this.book()?.progress;
    return !!p && p.progression > 0 && this.book()!.editions.find((e) => e.id === p.editionId)?.family === family;
  }

  protected readonly unofficial = computed(() =>
    !!this.book()?.editions.some((e) => e.fieldSources.some((f) => f.provider && UNOFFICIAL_PROVIDERS.includes(f.provider))),
  );

  protected readonly seriesItems = signal<WorkItem[]>([]);
  protected readonly authorItems = signal<WorkItem[]>([]);

  private readonly id = computed(() => this.media().id);
  private readonly seriesId = computed(() => this.book()?.series[0]?.id ?? null);
  private readonly authorId = computed(() => this.book()?.authors[0]?.id ?? null);

  constructor() {
    effect(() => {
      const id = this.id();
      const seriesId = this.seriesId();
      const authorId = this.authorId();
      untracked(() => {
        this.seriesItems.set([]);
        this.authorItems.set([]);
        void this.loadSeries(id, seriesId);
        void this.loadAuthor(id, authorId);
      });
    });
  }

  /** Plays the audio edition last listened to, else the first one with a file; the next volumes of the series queue behind it. */
  protected listen(): void {
    const { editions, progress, series } = this.book() ?? { editions: [], progress: null, series: [] };
    const playable = editions.filter((e) => e.family === 'audio' && e.hasFile && e.itemId != null);
    const edition = playable.find((e) => e.id === progress?.editionId) ?? playable[0];
    if (!edition?.itemId) return;
    const m = this.media();
    const volumes = this.seriesItems();
    const at = volumes.findIndex((v) => v.id === m.id);
    if (at >= 0 && series[0]) {
      this.queue.start(
        volumes.map((v) => ({ mediaId: v.id, title: v.title })),
        at,
        { source: 'series', sourceId: series[0].id, autoplay: true },
      );
    } else {
      this.queue.clear();
    }
    void this.audio.play({
      mediaId: m.id,
      itemId: edition.itemId,
      title: m.title,
      artist: (this.book()?.authors ?? []).map((a) => a.name).join(', '),
      coverUrl: edition.coverUrl ?? m.posterUrl,
    });
  }

  private async loadSeries(id: number, seriesId: number | null): Promise<void> {
    const items = seriesId == null ? [] : await this.api.collection(seriesId).then((c) => c.entries.map(toItem), () => []);
    if (this.id() === id) this.seriesItems.set(items);
  }

  private async loadAuthor(id: number, authorId: number | null): Promise<void> {
    const items =
      authorId == null
        ? []
        : await this.api.personWorks(authorId, 'author').then(
            (w) => {
              const entries = [...w.series.flatMap((s) => s.works.map(toItem)), ...w.standalone.map((m) => toItem({ position: null, positionEnd: null, positionLabel: null, media: m }))];
              return entries.filter((it, i) => it.id !== id && entries.findIndex((o) => o.id === it.id) === i);
            },
            () => [],
          );
    if (this.id() === id) this.authorItems.set(items);
  }
}
