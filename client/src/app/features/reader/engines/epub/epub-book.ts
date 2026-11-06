import { Injectable, computed, inject, signal } from '@angular/core';
import { DecorationStyleType, type EpubNavigator } from '@readium/navigator';
import { Layout, Locator, type Link, type Publication } from '@readium/shared';
import { ReaderSession } from '../../reader-session';
import { chapterBefore, chapterMarks, type ChapterMark } from './reader-estimates';

export interface TocRow {
  link: Link;
  title: string;
  depth: number;
}

export const pathOf = (href: string): string => href.split('#')[0];

export function parseLocator(raw: unknown): Locator | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  try {
    return Locator.deserialize(raw as never);
  } catch {
    return undefined;
  }
}

export const flattenToc = (links: Link[], depth = 0): TocRow[] =>
  links.flatMap((link) => [
    { link, title: link.title || link.href, depth },
    ...flattenToc(link.children?.items ?? [], depth + 1),
  ]);

/** Three blinks of the Fliks violet, ending off. */
const FLASH_TINT = '#605dff';
const FLASH_STEPS = 6;
const FLASH_STEP_MS = 280;

/** The open EPUB, shared by the engine and its parts: the toolkit's navigator, the book, where the reader is. */
@Injectable()
export class EpubBook {
  private readonly session = inject(ReaderSession);

  navigator: EpubNavigator | null = null;
  publication: Publication | null = null;
  positions: Locator[] = [];
  host: HTMLElement | null = null;
  destroyed = false;

  get fixed(): boolean {
    return this.publication?.metadata.effectiveLayout === Layout.fixed;
  }
  private flashTimer?: ReturnType<typeof setTimeout>;

  /** The navigator has shown its first page. */
  readonly ready = signal(false);
  readonly locator = signal<Locator | null>(null);
  readonly totalProgression = signal(0);
  readonly toc = signal<TocRow[]>([]);
  readonly marks = signal<ChapterMark[]>([]);
  private readonly currentHref = computed(() => pathOf(this.locator()?.href ?? ''));
  /** The first entry of the chapter on screen; later ones for the same file are its sections.
   *  A file the table of contents leaves out belongs to the chapter before it. */
  readonly currentRow = computed(() => {
    const own = this.toc().findIndex((row) => pathOf(row.link.href) === this.currentHref());
    return own >= 0 ? own : (chapterBefore(this.marks(), this.totalProgression())?.row ?? -1);
  });
  readonly chapterTitle = computed(() => this.toc()[this.currentRow()]?.title ?? '');
  readonly tocRows = computed(() => this.toc().map((r) => ({ href: r.link.href, title: r.title })));

  setToc(rows: TocRow[]): void {
    this.toc.set(rows);
    this.marks.set(
      chapterMarks(
        rows.map((r) => ({ href: pathOf(r.link.href), title: r.title })),
        this.positions,
      ),
    );
  }

  /** Jumps to a quoted passage and blinks an outline around it so the eye finds it on the page. */
  goToPassage(target: Locator | null | undefined): void {
    if (target) this.navigator?.go(target, false, (ok) => ok && this.flash(target));
    this.session.afterJump();
  }

  private flash(locator: Locator): void {
    const nav = this.navigator;
    if (!nav) return;
    clearTimeout(this.flashTimer);
    const on = [{ id: 'flash', locator, style: { type: DecorationStyleType.Outline, tint: FLASH_TINT } }];
    let step = 0;
    const tick = () => {
      nav.applyDecorations(step % 2 === 0 ? on : [], 'flash');
      if (++step < FLASH_STEPS) this.flashTimer = setTimeout(tick, FLASH_STEP_MS);
    };
    tick();
  }

  dispose(): void {
    this.destroyed = true;
    clearTimeout(this.flashTimer);
  }
}
