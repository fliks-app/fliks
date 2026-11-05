import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { DecorationStyleType } from '@readium/navigator';
import type { Locator } from '@readium/shared';
import { safeFileName, saveFile } from '../../../../core/plugins/save-file.plugin';
import { ToastService } from '../../../../core/services/toast.service';
import {
  ANNOTATION_COLOURS,
  AnnotationsApiService,
  type Annotation,
  type AnnotationColour,
} from '../../annotations-api.service';
import { COLOUR_HEX, annotationsMarkdown, groupByChapter } from '../../reader-annotations';
import type { ReaderNotes } from '../../reader-engine';
import { ReaderSession } from '../../reader-session';
import { EpubBook, parseLocator, pathOf } from './epub-book';

export const EXCERPT_MAX = 2000;

/** Bookmarks, highlights and their notes: kept on the server, painted on the pages. */
@Injectable()
export class EpubNotes implements ReaderNotes {
  private readonly api = inject(AnnotationsApiService);
  private readonly book = inject(EpubBook);
  private readonly session = inject(ReaderSession);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private marking = false;

  readonly list = signal<Annotation[]>([]);
  readonly focusId = signal<number | null>(null);
  readonly bookmarked = computed(() => {
    const loc = this.book.locator();
    return !!loc && this.list().some((a) => a.kind === 'bookmark' && sameSpot(a, loc));
  });

  constructor() {
    effect(() => {
      const highlights = this.list().filter((a) => a.kind === 'highlight');
      untracked(() => this.paint(highlights));
    });
  }

  async load(): Promise<void> {
    try {
      const list = await this.api.list(this.session.target().itemId);
      if (!this.book.destroyed) this.list.set(list);
    } catch {
      // Offline or refused: the book reads without its marks.
    }
  }

  /** Once the navigator has its frames, and on every change of the list. */
  paint(highlights = this.list().filter((a) => a.kind === 'highlight')): void {
    const nav = this.book.navigator;
    if (!nav) return;
    const decorations = highlights.flatMap((a) => {
      const locator = parseLocator(a.locator);
      return locator
        ? [{ id: String(a.id), locator, style: { type: DecorationStyleType.Highlight, tint: COLOUR_HEX[a.colour ?? 'yellow'] } }]
        : [];
    });
    nav.applyDecorations(decorations, 'annotations');
  }

  async toggleBookmark(): Promise<void> {
    const loc = this.book.locator();
    if (!loc || this.marking) return;
    this.marking = true;
    try {
      const here = this.list().find((a) => a.kind === 'bookmark' && sameSpot(a, loc));
      if (here) {
        await this.api.remove(here.id);
        this.list.update((list) => list.filter((a) => a.id !== here.id));
        return;
      }
      const created = await this.api.create(this.session.target().itemId, {
        kind: 'bookmark',
        locator: loc.serialize() as Record<string, unknown>,
        excerpt: this.book.chapterTitle().slice(0, EXCERPT_MAX),
      });
      this.list.update((list) => [...list, created]);
    } catch {
      // The error interceptor has already told the reader.
    } finally {
      this.marking = false;
    }
  }

  async highlight(colour: AnnotationColour, note: string, locator: Record<string, unknown>, excerpt: string): Promise<void> {
    try {
      const created = await this.api.create(this.session.target().itemId, {
        kind: 'highlight',
        colour,
        note,
        locator,
        excerpt,
      });
      this.list.update((list) => [...list, created]);
    } catch {
      // The error interceptor has already told the reader.
    }
  }

  go(a: Annotation): void {
    this.book.goToPassage(parseLocator(a.locator));
  }

  async save(change: { annotation: Annotation; note: string }): Promise<void> {
    try {
      const updated = await this.api.update(change.annotation.id, { note: change.note });
      this.list.update((list) => list.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      // The error interceptor has already told the reader.
    }
  }

  async remove(a: Annotation): Promise<void> {
    try {
      await this.api.remove(a.id);
      this.list.update((list) => list.filter((x) => x.id !== a.id));
    } catch {
      // The error interceptor has already told the reader.
    }
  }

  exportMarkdown(): void {
    const title = this.session.title();
    const labels = Object.fromEntries(
      ANNOTATION_COLOURS.map((c) => [c, this.translate.instant(`reader.colour_${c}`)]),
    ) as Record<AnnotationColour, string>;
    const groups = groupByChapter(this.list(), this.book.tocRows());
    const blob = new Blob([annotationsMarkdown(title, groups, labels)], { type: 'text/markdown' });
    void saveFile(blob, `${safeFileName(title, 'book')}.md`).catch(() =>
      this.toast.error(this.translate.instant('reader.export_failed')),
    );
  }
}

function sameSpot(a: Annotation, loc: Locator): boolean {
  const at = a.locator['locations'] as { position?: number } | undefined;
  return pathOf(String(a.locator['href'] ?? '')) === pathOf(loc.href) && at?.position === loc.locations.position;
}
