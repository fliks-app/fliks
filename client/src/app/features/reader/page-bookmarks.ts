import { computed, signal, type Signal } from '@angular/core';
import type { TranslateService } from '@ngx-translate/core';
import type { Annotation, AnnotationsApiService } from './annotations-api.service';
import type { ReaderNotes } from './reader-engine';
import { pdfPageOf, pdfProgression } from './pdf-position';

export interface PageBookmarkDeps {
  api: AnnotationsApiService;
  translate: TranslateService;
  itemId: () => number;
  page: Signal<number>;
  pages: () => number;
  /** The chapter a page sits in, for a format that has them. */
  title?: (page: number) => string;
  go: (page: number) => void;
  destroyed: () => boolean;
}

/** Bookmarks of a paged format (PDF, comic): one per page, no highlights, so the notes panel stays off. */
export class PageBookmarks {
  private readonly marks = signal<Annotation[]>([]);
  private busy = false;

  readonly notes: ReaderNotes = {
    list: this.marks,
    focusId: signal<number | null>(null),
    bookmarked: computed(() => this.marks().some((a) => a.locator['page'] === this.d.page())),
    toggleBookmark: () => this.toggle(),
    go: (a) => this.d.go(pdfPageOf(a.locator, this.d.pages())),
    remove: async (a) => {
      try {
        await this.d.api.remove(a.id);
        this.marks.update((list) => list.filter((m) => m.id !== a.id));
      } catch {
        // The error interceptor has already told the reader.
      }
    },
    save: async () => undefined,
    exportMarkdown: () => undefined,
  };

  constructor(private readonly d: PageBookmarkDeps) {}

  async load(): Promise<void> {
    try {
      const list = await this.d.api.list(this.d.itemId());
      if (!this.d.destroyed()) this.marks.set(list);
    } catch {
      // Offline or refused: the book reads without its marks.
    }
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const page = this.d.page();
    try {
      const here = this.marks().find((a) => a.locator['page'] === page);
      if (here) {
        await this.d.api.remove(here.id);
        this.marks.update((list) => list.filter((a) => a.id !== here.id));
        return;
      }
      const created = await this.d.api.create(this.d.itemId(), {
        kind: 'bookmark',
        locator: { page, title: this.d.title?.(page) ?? '', locations: { progression: pdfProgression(page, this.d.pages()) } },
        excerpt: this.d.translate.instant('reader.page_n', { n: page }),
      });
      this.marks.update((list) => [...list, created]);
    } catch {
      // The error interceptor has already told the reader.
    } finally {
      this.busy = false;
    }
  }
}
