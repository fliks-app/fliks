import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideCopy, LucideSearch, LucideShare2, LucideStickyNote } from '@lucide/angular';
import type { Locator } from '@readium/shared';
import { ToastService } from '../../../../core/services/toast.service';
import { ANNOTATION_COLOURS, type AnnotationColour } from '../../annotations-api.service';
import { COLOUR_HEX, blockOf, rangeContext } from '../../reader-annotations';
import { ReaderSession } from '../../reader-session';
import { EpubBook, pathOf } from './epub-book';
import { EXCERPT_MAX, EpubNotes } from './epub-notes';
import { EpubSearch } from './epub-search';
import { selectorOf } from './frame-hardening';

interface PendingSelection {
  x: number;
  y: number;
  text: string;
  locator: Record<string, unknown>;
  frame: HTMLIFrameElement | null;
}

/** What the toolkit reports for a selection made in one of its frames. */
export interface FrameSelection {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  targetFrameSrc: string;
  locator?: Locator;
}

const CONTEXT_CHARS = 40;

/** The toolbar over selected text: highlight in a colour, add a note, copy, search, share. */
@Component({
  selector: 'app-epub-selection',
  imports: [TranslatePipe, LucideCopy, LucideSearch, LucideShare2, LucideStickyNote],
  templateUrl: './epub-selection.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class EpubSelectionComponent {
  private readonly book = inject(EpubBook);
  private readonly notes = inject(EpubNotes);
  private readonly search = inject(EpubSearch);
  private readonly session = inject(ReaderSession);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly selection = signal<PendingSelection | null>(null);
  protected readonly writing = signal(false);
  protected readonly colours = ANNOTATION_COLOURS;
  protected readonly hex = COLOUR_HEX;

  get active(): boolean {
    return this.selection() !== null;
  }

  show(sel: FrameSelection): void {
    const text = sel.text.trim();
    const nav = this.book.navigator;
    if (!text || !nav || !this.book.host) return;
    const frame = [...this.book.host.querySelectorAll('iframe')].find((f) => {
      try {
        return f.contentWindow?.location.href === sel.targetFrameSrc;
      } catch {
        return false;
      }
    });
    const rect = frame?.getBoundingClientRect();
    const range = frame?.contentWindow?.getSelection()?.rangeCount ? frame.contentWindow.getSelection()!.getRangeAt(0) : null;
    const current = nav.currentLocator;
    const { before, after, progression } = range
      ? rangeContext(range, CONTEXT_CHARS)
      : { before: '', after: '', progression: current.locations.progression ?? 0 };
    const block = range ? blockOf(range) : null;
    const cssSelector = block ? selectorOf(block) : undefined;
    this.writing.set(false);
    this.selection.set({
      x: (rect?.left ?? 0) + sel.x + sel.width / 2,
      y: (rect?.top ?? 0) + sel.y,
      text: text.slice(0, EXCERPT_MAX),
      frame: frame ?? null,
      locator: {
        href: pathOf(sel.locator?.href ?? current.href),
        type: 'application/xhtml+xml',
        title: this.book.chapterTitle(),
        locations: {
          progression,
          position: current.locations.position ?? 0,
          totalProgression: this.book.totalProgression(),
          ...(cssSelector && { cssSelector }),
        },
        text: { before, highlight: text.slice(0, EXCERPT_MAX), after },
      },
    });
  }

  /** Drops the toolbar; the text stays selected unless `deselect`. */
  dismiss(deselect = false): void {
    this.selection.update((s) => {
      if (deselect) s?.frame?.contentWindow?.getSelection()?.removeAllRanges();
      return null;
    });
    this.writing.set(false);
  }

  protected highlight(colour: AnnotationColour, note = ''): void {
    const sel = this.selection();
    if (!sel) return;
    this.dismiss(true);
    void this.notes.highlight(colour, note, sel.locator, sel.text);
  }

  protected saveDraft(e: Event): void {
    const note = (e.target as HTMLFormElement).querySelector('textarea')?.value.trim() ?? '';
    this.highlight('yellow', note);
  }

  protected async copy(): Promise<void> {
    const text = this.selection()?.text;
    if (!text) return;
    this.dismiss(true);
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(this.translate.instant('reader.copied'));
    } catch {
      this.toast.error(this.translate.instant('reader.copy_failed'));
    }
  }

  protected async share(): Promise<void> {
    const text = this.selection()?.text;
    if (!text) return;
    const quote = `« ${text} » – ${this.session.title()}`.trim();
    this.dismiss(true);
    try {
      if (navigator.share) await navigator.share({ text: quote });
      else {
        await navigator.clipboard.writeText(quote);
        this.toast.success(this.translate.instant('reader.copied'));
      }
    } catch {
      // A dismissed share sheet is not an error.
    }
  }

  protected find(): void {
    const text = this.selection()?.text;
    if (!text) return;
    this.dismiss(true);
    this.search.find(text);
  }
}
