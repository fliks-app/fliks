import type { Signal, WritableSignal } from '@angular/core';
import type { Annotation } from './annotations-api.service';
import type { ComicPrefs } from './comic-layout';
import type { ReaderKeyAction } from './reader-keys';
import type { SearchHit } from './reader-search';
import type { TocEntry } from './reader-sidebar';

/** The footer's reading position. `section` is the chapter, empty for a format without one. */
export interface ReaderStatus {
  section: string;
  /** What is left of the section: screens when they are counted, else minutes. */
  sectionLeft: { pages: number } | { minutes: number } | null;
  page: number | null;
  pages: number | null;
  bookLeft: { h: number; m: number } | null;
}

/** What the progress bar previews for a position under the pointer or the thumb. */
export interface ScrubPreview {
  section: string;
  page: number | null;
}

export interface ReaderToc {
  entries: Signal<TocEntry[]>;
  rows: Signal<{ href: string; title: string }[]>;
  current: Signal<number>;
  /** The furthest point read, so chapters stay marked read after a jump back. */
  readThrough: Signal<number>;
  go(index: number): void;
}

export interface ReaderNotes {
  list: Signal<Annotation[]>;
  /** The note a tap on its highlight opened. */
  focusId: WritableSignal<number | null>;
  bookmarked: Signal<boolean>;
  toggleBookmark(): Promise<void>;
  go(a: Annotation): void;
  remove(a: Annotation): Promise<void>;
  save(change: { annotation: Annotation; note: string }): Promise<void>;
  exportMarkdown(): void;
}

export interface ReaderSearch {
  hits: Signal<SearchHit[]>;
  searching: Signal<boolean>;
  searched: Signal<boolean>;
  text: Signal<string>;
  run(query: string): Promise<void>;
  cancel(): void;
  go(hit: SearchHit): void;
}

export interface ReaderZoom {
  canIn: Signal<boolean>;
  canOut: Signal<boolean>;
  by(dir: 1 | -1): void;
}

export interface ReaderLayout {
  prefs: Signal<ComicPrefs>;
  set(prefs: ComicPrefs): void;
}

/** One format's way to show a book. The reader around it owns the bars, the panels and the keys. */
export interface ReaderEngine {
  loading: Signal<boolean>;
  rtl: Signal<boolean>;
  /** 0..1, the position shown on the progress bar. */
  progression: Signal<number>;
  /** Stops of the progress bar: the pages of a paged format. */
  steps: Signal<number>;
  /** Where the progress bar's segments start, 0..1. */
  segments: Signal<number[]>;
  status: Signal<ReaderStatus>;
  preview(at: number): ScrubPreview;
  seek(at: number): void;
  /** A movement, or `close` when the engine has something of its own to dismiss first; true when handled. */
  act(action: ReaderKeyAction): boolean;
  /** Keys of the format's own, such as zoom; true when handled. */
  onKey?(e: KeyboardEvent): boolean;
  toc?: ReaderToc;
  notes?: ReaderNotes;
  search?: ReaderSearch;
  zoom?: ReaderZoom;
  layout?: ReaderLayout;
}
