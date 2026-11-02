import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BooksApiService } from '../../../../core/services/api/books-api.service';
import type { BookPreview } from '../../../../core/services/api/books.models';
import { LibrariesApiService, Library } from '../../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { ToastService } from '../../../../core/services/toast.service';
import { mediaDetailLink } from '../../../../core/media-kinds';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';

interface LibraryFolder { id: number; path: string }

/** The add preview of a book: the work, its editions, and Add. Requests for books are not offered yet. */
@Component({
  selector: 'app-book-preview',
  imports: [FormsModule, RouterLink, TranslatePipe, TvSelectDirective],
  templateUrl: './book-preview.component.html',
})
export class BookPreviewComponent implements OnInit {
  private readonly api = inject(BooksApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();

  protected readonly book = signal<BookPreview | null>(null);
  protected readonly failed = signal(false);
  protected readonly adding = signal(false);
  protected readonly libraries = signal<Library[]>([]);
  protected readonly libraryId = signal<number | null>(null);
  protected readonly folderId = signal<number | null>(null);

  protected readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  protected readonly bookLibraries = computed(() => this.libraries().filter((l) => l.mediaTypes.includes('book')));
  protected readonly folders = computed<LibraryFolder[]>(() => {
    const lib = this.bookLibraries().find((l) => l.id === this.libraryId()) as
      | (Library & { folders?: LibraryFolder[] })
      | undefined;
    return lib?.folders ?? [];
  });
  protected readonly authors = computed(() => this.book()?.authors.join(', ') ?? '');
  protected readonly seriesLabel = computed(() => {
    const s = this.book()?.series;
    return s ? (s.position ? `${s.name} #${s.position}` : s.name) : '';
  });
  protected readonly inLibraryLink = computed(() => {
    const id = this.book()?.mediaId;
    return id ? mediaDetailLink('book', id) : null;
  });

  async ngOnInit() {
    try {
      this.book.set(await this.api.preview(this.provider(), this.externalId()));
    } catch {
      this.failed.set(true);
      return;
    }
    if (!this.canImport()) return;
    try {
      this.libraries.set(await this.librariesApi.list());
    } catch { /* the picker stays empty, Add stays disabled */ }
    this.selectLibrary(this.bookLibraries()[0]?.id ?? null);
  }

  protected selectLibrary(id: number | null) {
    this.libraryId.set(id);
    this.folderId.set(this.folders()[0]?.id ?? null);
  }

  protected duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}` : `${m} min`;
  }

  async add() {
    if (!this.book() || this.adding()) return;
    this.adding.set(true);
    try {
      const libraryId = this.libraryId();
      const folderId = this.folderId();
      const saved = await this.api.import({
        type: 'book',
        provider: this.provider(),
        externalId: this.externalId(),
        ...(libraryId != null ? { libraryId } : {}),
        ...(this.folders().length > 1 && folderId != null ? { folderId } : {}),
      });
      this.toast.success(this.translate.instant('discover.import_success'));
      void this.router.navigate(mediaDetailLink('book', saved.id));
    } catch {
      this.toast.error(this.translate.instant('discover.import_error'));
    } finally {
      this.adding.set(false);
    }
  }
}
