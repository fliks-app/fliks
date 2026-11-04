import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideBookmark,
  LucideCheck,
  LucideDownload,
  LucidePencil,
  LucideSearch,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import {
  ANNOTATION_COLOURS,
  type Annotation,
  type AnnotationColour,
} from './annotations-api.service';
import { COLOUR_HEX, groupByChapter } from './reader-annotations';
import type { SearchHit } from './reader-search';

export type SidebarTab = 'contents' | 'bookmarks' | 'notes' | 'search';

export interface TocEntry {
  title: string;
  depth: number;
  /** Where the chapter starts and ends in the book, 0..1. */
  start: number;
  end: number;
}

/** The side panel: contents with read marks, bookmarks, highlights and notes grouped by chapter, and the search results. */
@Component({
  selector: 'app-reader-sidebar',
  imports: [
    DatePipe,
    TranslatePipe,
    LucideBookmark,
    LucideCheck,
    LucideDownload,
    LucidePencil,
    LucideSearch,
    LucideTrash2,
    LucideX,
  ],
  templateUrl: './reader-sidebar.html',
  styleUrl: './reader-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReaderSidebarComponent {
  readonly tab = model.required<SidebarTab>();
  readonly toc = input.required<TocEntry[]>();
  readonly currentRow = input.required<number>();
  readonly progression = input.required<number>();
  readonly annotations = input.required<Annotation[]>();
  readonly tocRows = input.required<{ href: string; title: string }[]>();
  readonly hits = input.required<SearchHit[]>();
  readonly searching = input.required<boolean>();
  readonly searched = input.required<boolean>();
  readonly focusId = input<number | null>(null);
  readonly searchText = input('');

  readonly closed = output<void>();
  readonly goToc = output<number>();
  readonly goAnnotation = output<Annotation>();
  readonly removeAnnotation = output<Annotation>();
  readonly saveNote = output<{ annotation: Annotation; note: string }>();
  readonly exportMarkdown = output<void>();
  readonly query = output<string>();
  readonly goHit = output<SearchHit>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly tabs: SidebarTab[] = ['contents', 'bookmarks', 'notes'];
  protected readonly colours = ANNOTATION_COLOURS;
  protected readonly hex = COLOUR_HEX;
  protected readonly filter = signal<AnnotationColour | null>(null);
  protected readonly editing = signal<number | null>(null);

  protected readonly bookmarks = computed(() =>
    this.annotations().filter((a) => a.kind === 'bookmark'),
  );
  protected readonly highlights = computed(() =>
    this.annotations().filter((a) => a.kind === 'highlight'),
  );
  protected readonly notes = computed(() => {
    const f = this.filter();
    return groupByChapter(
      this.highlights().filter((a) => !f || a.colour === f),
      this.tocRows(),
    );
  });
  protected readonly bookmarkGroups = computed(() =>
    groupByChapter(this.bookmarks(), this.tocRows()),
  );

  constructor() {
    // The panel opens with a control focused: the search field on its tab, else the selected tab.
    effect(() => {
      const search = this.tab() === 'search';
      afterNextRender(
        () =>
          this.host.nativeElement
            .querySelector<HTMLElement>(search ? 'input[type=search]' : '[role=tab][aria-selected=true]')
            ?.focus(),
        { injector: this.injector },
      );
    });
  }

  /** A chapter is read once the reader is past its end; the current one shows how far in it is. */
  protected isRead(e: TocEntry, i: number): boolean {
    return i !== this.currentRow() && e.end <= this.progression() + 1e-6;
  }

  protected chapterPercent(e: TocEntry): number {
    const span = e.end - e.start;
    return span > 0
      ? Math.round(Math.min(1, Math.max(0, (this.progression() - e.start) / span)) * 100)
      : 0;
  }

  protected count(colour: AnnotationColour): number {
    return this.highlights().filter((a) => a.colour === colour).length;
  }

  protected toggleFilter(colour: AnnotationColour): void {
    this.filter.update((f) => (f === colour ? null : colour));
  }

  protected startEdit(id: number): void {
    this.editing.set(id);
    afterNextRender(() => this.host.nativeElement.querySelector('textarea')?.focus(), {
      injector: this.injector,
    });
  }

  protected commit(a: Annotation, value: string): void {
    this.editing.set(null);
    const note = value.trim();
    if (note !== a.note) this.saveNote.emit({ annotation: a, note });
  }

  /** Saves a note still being typed; the owner calls it before the panel goes, as no blur follows a removal. */
  flushNote(): void {
    const id = this.editing();
    const field = this.host.nativeElement.querySelector('textarea');
    const a = this.annotations().find((x) => x.id === id);
    if (a && field) this.commit(a, field.value);
  }

  protected text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
}
