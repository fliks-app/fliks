import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { MediaService } from '../../core/services/api/media.service';
import { NavbarService } from '../../core/services/navbar.service';
import { ToastService } from '../../core/services/toast.service';
import { ComicsApiService } from '../../core/services/api/comics-api.service';
import type { ComicPageSize } from '../../core/services/api/comics.models';
import { COMIC_ARCHIVES, asBookMedia, readable } from '../../core/services/api/book-media';
import { asComicMedia, type ComicMedia } from '../media-detail/comic/comic-media';
import { ReaderComponent } from './reader';
import type { ReaderTarget } from './reader-api.service';
import type { ReaderFormat } from './reader-features';
import type { ReaderBookInfo } from './reader-session';

interface Opened {
  format: ReaderFormat;
  /** Set for a comic issue read as images. */
  pages?: ComicPageSize[];
  title: string;
  target: ReaderTarget;
  info?: ReaderBookInfo;
}

/** `/read/:mediaId/:itemId`: finds the item's file among the book's editions and opens it in the reader. */
@Component({
  selector: 'app-reader-page',
  imports: [ReaderComponent],
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
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.gone = true));
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
      const localKey = downloaded?.book?.files[0]?.key;
      if (!book && downloaded?.book?.format && ['epub', 'pdf'].includes(downloaded.book.format)) {
        // The work page is out of reach offline: the download carries what the reader needs.
        this.opened.set({
          format: downloaded.book.format as Opened['format'],
          title: downloaded.media?.title ?? '',
          target: { mediaId, itemId, fileId: downloaded.mediaFileId, localKey },
        });
        return;
      }
      const edition = book?.book.editions.find((e) => e.itemId === itemId && readable(e));
      const format = edition?.format?.toLowerCase();
      if (!book || !edition || !format) throw new Error('not readable');
      const target = { mediaId, itemId, fileId: edition.fileIds[0], localKey };
      if (COMIC_ARCHIVES.includes(format)) {
        this.opened.set({ format: 'comic', title: book.title, target, pages: await this.comics.pages(itemId) });
        return;
      }
      const audio = book.book.editions.find((e) => e.family === 'audio' && e.hasFile && e.itemId != null);
      const info: ReaderBookInfo = {
        author: book.book.authors.map((a) => a.name).join(', '),
        coverUrl: edition.coverUrl ?? book.posterUrl,
        listen: audio?.itemId != null ? { itemId: audio.itemId, coverUrl: audio.coverUrl } : null,
      };
      this.opened.set({ format: format as Opened['format'], title: book.title, target, info });
    } catch {
      if (this.gone) return;
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
