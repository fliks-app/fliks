import { ChangeDetectionStrategy, Component, afterNextRender, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { MediaService } from '../../core/services/api/media.service';
import { NavbarService } from '../../core/services/navbar.service';
import { ToastService } from '../../core/services/toast.service';
import { ComicsApiService } from '../../core/services/api/comics-api.service';
import type { ComicPageSize } from '../../core/services/api/comics.models';
import { asBookMedia } from '../media-detail/book/book-media';
import { asComicMedia, type ComicMedia } from '../media-detail/comic/comic-media';
import { PdfReaderComponent } from './pdf-reader';
import { ComicReaderComponent } from './comic-reader';
import { ReaderComponent } from './reader';
import type { ReaderTarget } from './reader-api.service';

interface Opened {
  format: 'epub' | 'pdf' | 'comic';
  /** Set for a comic issue read as images. */
  pages?: ComicPageSize[];
  title: string;
  target: ReaderTarget;
}

/** `/read/:mediaId/:itemId`: finds the item's file among the book's editions and hands it to the reader of its format. */
@Component({
  selector: 'app-reader-page',
  imports: [ReaderComponent, PdfReaderComponent, ComicReaderComponent],
  templateUrl: './reader-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReaderPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly media = inject(MediaService);
  private readonly navbar = inject(NavbarService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly downloads = inject(DownloadCacheService);
  private readonly comics = inject(ComicsApiService);

  protected readonly opened = signal<Opened | null>(null);

  constructor() {
    afterNextRender(() => void this.resolve());
  }

  protected back(): void {
    this.navbar.goBack(['/']);
  }

  private async resolve(): Promise<void> {
    const param = (name: string) => Number(this.route.snapshot.paramMap.get(name));
    const mediaId = param('mediaId');
    const itemId = param('itemId');
    try {
      const loaded = await this.media.getOne(mediaId).catch(() => null);
      const comic = asComicMedia(loaded);
      if (comic) return await this.openComic(comic, itemId);
      const book = asBookMedia(loaded);
      const downloaded = this.downloads.tasks().find((t) => t.book?.family === 'text' && t.book.itemId === itemId && t.status === 'ready');
      if (!book && downloaded?.book?.format && ['epub', 'pdf'].includes(downloaded.book.format)) {
        // The work page is out of reach offline: the download carries what the reader needs.
        this.opened.set({
          format: downloaded.book.format as Opened['format'],
          title: downloaded.media?.title ?? '',
          target: { mediaId, itemId, fileId: downloaded.mediaFileId },
        });
        return;
      }
      const edition = book?.book.editions.find((e) => e.itemId === itemId && e.family === 'text' && e.fileIds.length);
      const format = edition?.format?.toLowerCase();
      if (!book || !edition || (format !== 'epub' && format !== 'pdf')) throw new Error('not readable');
      this.opened.set({ format, title: book.title, target: { mediaId, itemId, fileId: edition.fileIds[0] } });
    } catch {
      this.toast.error(this.translate.instant('reader.open_failed'));
      this.back();
    }
  }

  /** An image issue opens the page reader, a PDF issue the PDF reader. */
  private async openComic(comic: ComicMedia, itemId: number): Promise<void> {
    const issue = comic.comic.issues.find((i) => i.itemId === itemId);
    if (!issue?.mediaFileId) throw new Error('not readable');
    const base = { title: comic.title, target: { mediaId: comic.id, itemId, fileId: issue.mediaFileId } };
    if (issue.format === 'pdf') return void this.opened.set({ ...base, format: 'pdf' });
    this.opened.set({ ...base, format: 'comic', pages: await this.comics.pages(itemId) });
  }
}
