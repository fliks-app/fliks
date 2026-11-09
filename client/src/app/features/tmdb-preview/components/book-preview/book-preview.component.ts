import { Component, OnDestroy, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TranslatePluralPipe, translatePlural } from '../../../../core/pipes/translate-plural.pipe';
import { BooksApiService } from '../../../../core/services/api/books-api.service';
import type { BookPreview } from '../../../../core/services/api/books.models';
import { AuthService } from '../../../../core/services/auth.service';
import { RequestsService } from '../../../../core/services/api/requests.service';
import { mediaDetailLink } from '../../../../core/media-kinds';
import type { WantSpec } from '../../../../core/services/api/wants-api.service';
import { LucidePlus } from '@lucide/angular';
import { AddDialogComponent } from '../../../../shared/components/add-dialog/add-dialog';
import type { AddResult } from '../../../../shared/components/add-dialog/add-plan';
import { DetailSectionComponent } from '../../../../shared/components/detail-section/detail-section';
import { FactsGridComponent, type Fact } from '../../../../shared/components/facts-grid/facts-grid';
import { HeroBaseComponent, type HeroChip } from '../../../../shared/components/hero-base/hero-base';
import { PREVIEW_HOST, type PreviewSeed } from '../../preview-host';
import { localizeLanguage } from '../../../../core/utils/language.utils';
import { previewPosterName } from '../../../../shared/utils/view-transition';

/** The add preview of a book: the work, its editions, and Add, or Request for a user who cannot add. */
@Component({
  selector: 'app-book-preview',
  imports: [RouterLink, TranslatePipe, TranslatePluralPipe, AddDialogComponent, DetailSectionComponent, FactsGridComponent, HeroBaseComponent, LucidePlus],
  templateUrl: './book-preview.component.html',
})
export class BookPreviewComponent implements OnInit, OnDestroy {
  private readonly api = inject(BooksApiService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly requests = inject(RequestsService);
  private readonly host = inject(PREVIEW_HOST);
  private readonly addDialog = viewChild(AddDialogComponent);
  private destroyed = false;

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();
  readonly seed = input<PreviewSeed | null>(null);

  protected readonly book = signal<BookPreview | null>(null);
  /** The card's title and cover until the preview lands. */
  /** The card's cover wins over the work's: the search may show another edition's cover. */
  protected readonly hero = computed(() => {
    const b = this.book();
    const s = this.seed();
    const posterUrl = s?.posterUrl ?? b?.posterUrl ?? null;
    if (b) return { title: b.title, posterUrl };
    return s ? { title: s.title, posterUrl } : null;
  });
  protected readonly posterTransitionName = computed(() => previewPosterName('book', this.provider(), this.externalId()));
  protected readonly languageLabel = computed(() => localizeLanguage(this.book()?.language, this.translate));
  protected readonly metaParts = computed(() => {
    const b = this.book();
    if (!b) return [];
    const pages = b.pageCount ? translatePlural(this.translate, 'books_search.pages', b.pageCount) : '';
    return [b.year ? String(b.year) : '', pages].filter(Boolean);
  });
  protected readonly chips = computed<HeroChip[]>(() => [{ label: 'kinds.book', cls: 'badge badge-outline badge-sm md:badge-md' }]);
  protected readonly facts = computed<Fact[]>(() => {
    const b = this.book();
    return [
      { label: 'books_search.series', value: this.seriesLabel() },
      { label: 'books_search.publisher', value: b?.publisher },
      { label: 'books_search.published', value: b?.published },
      { label: 'discover.preview_original_language', value: b?.language ? this.languageLabel() : null },
    ];
  });
  protected readonly editionsShown = signal(5);
  protected readonly editions = computed(() => this.book()?.editions.slice(0, this.editionsShown()) ?? []);
  protected readonly failed = signal(false);
  /** The editions already asked for by an active request. */
  protected readonly requested = signal<WantSpec[]>([]);
  protected readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  protected readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));
  protected readonly authors = computed(() => this.book()?.authors.join(', ') ?? '');
  protected readonly seriesLabel = computed(() => {
    const s = this.book()?.series;
    return s ? (s.position ? `${s.name} #${s.position}` : s.name) : '';
  });
  protected readonly inLibraryLink = computed(() => {
    const id = this.book()?.existingMediaId;
    return id ? mediaDetailLink('book', id) : null;
  });

  async ngOnInit() {
    let book: BookPreview;
    try {
      book = await this.api.preview(this.provider(), this.externalId());
    } catch {
      this.failed.set(true);
      return;
    }
    if (this.destroyed) return;
    this.book.set(book);
    this.host.setTitle(book.title);
    // A book has no backdrop: its cover, blurred, stands in like on the book page.
    this.host.setBackground(book.fanartUrl ?? this.hero()?.posterUrl ?? null, { blur: !book.fanartUrl });
    if (this.canRequest()) void this.loadRequested();
  }

  ngOnDestroy() {
    this.destroyed = true;
  }

  /** The editions are chosen in the dialog, so it opens even when one library takes the book. */
  protected openDialog() {
    const book = this.book();
    if (!book) return;
    void this.addDialog()?.add({
      kind: 'book',
      provider: this.provider(),
      externalId: this.externalId(),
      title: book.title,
      mode: this.canImport() ? 'import' : 'request',
      alwaysAsk: true,
      requestedWants: this.requested(),
    });
  }

  protected onAdded(r: AddResult) {
    if (r.mode === 'request') void this.loadRequested();
    else if (r.mediaId != null && !this.destroyed) void this.router.navigate(mediaDetailLink('book', r.mediaId));
  }

  private async loadRequested() {
    try {
      this.requested.set((await this.requests.getBookTitleState(this.externalId())).requestedWants ?? []);
    } catch { /* the note is optional, the server refuses a duplicate anyway */ }
  }

  protected language(code: string): string {
    return localizeLanguage(code, this.translate);
  }

  protected duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}` : `${m} min`;
  }
}
