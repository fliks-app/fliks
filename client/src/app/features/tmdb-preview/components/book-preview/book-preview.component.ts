import { Component, ElementRef, OnDestroy, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TranslatePluralPipe, translatePlural } from '../../../../core/pipes/translate-plural.pipe';
import { BooksApiService } from '../../../../core/services/api/books-api.service';
import type { BookPreview } from '../../../../core/services/api/books.models';
import { LibrariesApiService, LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { RequestsService } from '../../../../core/services/api/requests.service';
import { ToastService } from '../../../../core/services/toast.service';
import { mediaDetailLink } from '../../../../core/media-kinds';
import type { WantSpec } from '../../../../core/services/api/wants-api.service';
import { RequestWantsComponent } from '../../../requests/request-wants/request-wants';
import { WantsEditorComponent } from '../../../../shared/components/wants-editor/wants-editor';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';
import { LucidePlus } from '@lucide/angular';
import { DetailSectionComponent } from '../../../../shared/components/detail-section/detail-section';
import { FactsGridComponent, type Fact } from '../../../../shared/components/facts-grid/facts-grid';
import { HeroBaseComponent, type HeroChip } from '../../../../shared/components/hero-base/hero-base';
import { PREVIEW_HOST, type PreviewSeed } from '../../preview-host';
import { localizeLanguage } from '../../../../core/utils/language.utils';
import { previewPosterName } from '../../../../shared/utils/view-transition';
import {
  LibraryFolderSelectComponent,
  defaultFolderId,
} from '../../../../shared/components/library-folder-select/library-folder-select';

/** The add preview of a book: the work, its editions, and Add, or Request for a user who cannot add. */
@Component({
  selector: 'app-book-preview',
  imports: [FormsModule, RouterLink, TranslatePipe, TranslatePluralPipe, TvSelectDirective, DetailSectionComponent, FactsGridComponent, HeroBaseComponent, ModalHeaderComponent, ModalFooterComponent, LibraryFolderSelectComponent, WantsEditorComponent, RequestWantsComponent, LucidePlus],
  templateUrl: './book-preview.component.html',
})
export class BookPreviewComponent implements OnInit, OnDestroy {
  private readonly api = inject(BooksApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly requests = inject(RequestsService);
  private readonly host = inject(PREVIEW_HOST);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('addDialog');
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
  protected readonly adding = signal(false);
  /** The editions already asked for by an active request. */
  protected readonly requested = signal<WantSpec[]>([]);
  protected readonly libraries = signal<LibrarySummary[]>([]);
  protected readonly libraryId = signal<number | null>(null);
  protected readonly folderId = signal<number | null>(null);
  protected readonly wants = signal<WantSpec[]>([{ family: 'text', language: null }]);

  protected readonly wantsReady = computed(() => this.wants().every((w) => w.qualityProfileId != null));
  protected readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  protected readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));
  protected readonly bookLibraries = computed(() => this.libraries().filter((l) => l.mediaTypes.includes('book')));
  protected readonly folders = computed(
    () => this.bookLibraries().find((l) => l.id === this.libraryId())?.folders ?? [],
  );
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
    if (!this.canImport() && !this.canRequest()) return;
    if (this.canRequest()) void this.loadRequested();
    try {
      this.libraries.set(await this.librariesApi.listMine());
    } catch { /* the picker stays empty, Add stays disabled */ }
    this.selectLibrary(this.bookLibraries()[0]?.id ?? null);
  }

  ngOnDestroy() {
    this.destroyed = true;
  }

  protected openDialog() {
    this.dialog()?.nativeElement.showModal();
  }

  protected closeDialog() {
    this.dialog()?.nativeElement.close();
  }

  private async loadRequested() {
    try {
      this.requested.set((await this.requests.getBookTitleState(this.externalId())).requestedWants ?? []);
    } catch { /* the note is optional, the server refuses a duplicate anyway */ }
  }

  protected selectLibrary(id: number | null) {
    this.libraryId.set(id);
    this.folderId.set(defaultFolderId(this.folders()));
  }

  protected language(code: string): string {
    return localizeLanguage(code, this.translate);
  }

  protected duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}` : `${m} min`;
  }

  async add() {
    const wants = this.wants().flatMap((w) => (w.qualityProfileId == null ? [] : [{ ...w, qualityProfileId: w.qualityProfileId }]));
    if (!this.book() || this.adding() || wants.length !== this.wants().length) return;
    this.adding.set(true);
    try {
      const libraryId = this.libraryId();
      const folderId = this.folderId();
      const saved = await this.api.import({
        type: 'book',
        provider: this.provider(),
        externalId: this.externalId(),
        wants,
        ...(libraryId != null ? { libraryId } : {}),
        ...(this.folders().length > 1 && folderId != null ? { folderId } : {}),
      });
      if (this.destroyed) return;
      this.toast.success(this.translate.instant('discover.import_success'));
      void this.router.navigate(mediaDetailLink('book', saved.id));
    } catch {
      // The global HTTP interceptor toasts the failure.
    } finally {
      this.adding.set(false);
    }
  }

  async request() {
    const book = this.book();
    if (!book || this.adding()) return;
    this.adding.set(true);
    try {
      const libraryId = this.libraryId();
      const folderId = this.folderId();
      await this.requests.create({
        mediaType: 'book',
        externalId: this.externalId(),
        title: book.title,
        wants: this.wants(),
        ...(libraryId != null ? { libraryId } : {}),
        ...(this.folders().length > 1 && folderId != null ? { folderId } : {}),
      });
      if (this.destroyed) return;
      this.toast.success(this.translate.instant('book_requests.request_success'));
      this.closeDialog();
      await this.loadRequested();
    } catch {
      // the error interceptor shows the server's message (quota, duplicate edition)
    } finally {
      this.adding.set(false);
    }
  }
}
