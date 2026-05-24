import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  inject,
  input,
  signal,
  viewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvService } from '../../core/services/tv.service';

@Component({
  selector: 'app-horizontal-scroller',
  imports: [LucideChevronLeft, LucideChevronRight, TvRowDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Header: title + arrows (arrows are mouse-only — hidden on touch/TV,
         and when content fits without scrolling so we don't show two grey
         disabled chevrons doing nothing). -->
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-lg font-bold">{{ title() }}</h2>
      @if (!atStart() || !atEnd()) {
        <div class="flex gap-1 scroll-arrows">
          <button
            type="button"
            tabindex="-1"
            class="btn btn-ghost btn-sm btn-circle"
            [disabled]="atStart()"
            (click)="scrollLeft()"
          >
            <svg lucideChevronLeft class="h-5 w-5"></svg>
          </button>
          <button
            type="button"
            tabindex="-1"
            class="btn btn-ghost btn-sm btn-circle"
            [disabled]="atEnd()"
            (click)="scrollRight()"
          >
            <svg lucideChevronRight class="h-5 w-5"></svg>
          </button>
        </div>
      }
    </div>
    <!-- Scrollable content (no visible scrollbar). Vertical / horizontal
         padding (with matching negative margin so neighbours don't shift)
         makes room for the focus ring + media-card scale-up — both extend
         past the row and would otherwise be clipped by overflow-x:auto's
         implicit overflow-y. -->
    <div
      #scroller
      appTvRow
      class="flex gap-2 lg:gap-4 overflow-x-auto scrollbar-none [scroll-behavior:smooth] py-5 -my-5 px-4 -mx-4 lg:px-5 lg:-mx-5 scroll-px-4 lg:scroll-px-5"
      (scroll)="updateArrows()"
    >
      <ng-content />
    </div>
  `,
  styles: [`
    .scrollbar-none {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .scrollbar-none::-webkit-scrollbar {
      display: none;
    }
    /* Hide the < > scroll arrows on touch / TV — they're mouse-only ergonomy.
       Use both a body.tv selector (reliable) and a hover-media query (web touch). */
    :host-context(body.tv) .scroll-arrows { display: none; }
    @media (hover: none) {
      .scroll-arrows { display: none; }
    }
  `],
})
export class HorizontalScrollerComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tv = inject(TvService);
  readonly title = input('');
  readonly atStart = signal(true);
  readonly atEnd = signal(false);

  private readonly scrollerEl = viewChild<ElementRef<HTMLElement>>('scroller');
  private resizeObserver?: ResizeObserver;

  /** Smooth-scroll the page so this row's top sits at the viewport top
   *  when focus arrives from outside (e.g. the row above/below). The
   *  spatial-nav default `focus()` triggers an `instant` scrollIntoView
   *  that drops the user mid-row — this hostlistener replaces it with
   *  a smooth, row-aligned animation. Skips when focus moves between
   *  cards inside the same rail. */
  @HostListener('focusin', ['$event'])
  protected onFocusIn(event: FocusEvent): void {
    const from = event.relatedTarget as Node | null;
    if (from && this.host.nativeElement.contains(from)) return;
    queueMicrotask(() => this.snapToRowTop());
  }

  private snapToRowTop(): void {
    if (typeof window === 'undefined') return;
    const scrollEl = document.scrollingElement ?? document.documentElement;
    const rect = this.host.nativeElement.getBoundingClientRect();
    const currentTop = scrollEl.scrollTop ?? 0;
    // Leave a gap above the row title so the focused row doesn't sit
    // flush against the viewport edge. On TV the cast/user dock floats
    // top-right (~48 px tall at top:24); bump the offset so the focused
    // row clears the dock with its own breathing room.
    const TOP_OFFSET = this.tv.isTv() ? 96 : 24;
    // Skip when the row is already fully visible in the viewport: the
    // user is just walking between visible rows, no scroll is warranted.
    // Only snap when the row is partially / fully off-screen, in which
    // case we need to bring it back into view.
    const viewportH = window.innerHeight;
    if (rect.top >= TOP_OFFSET && rect.bottom <= viewportH) return;
    const targetTop = Math.max(0, currentTop + rect.top - TOP_OFFSET);
    if (Math.abs(targetTop - currentTop) < 4) return;
    try {
      window.scrollTo({ top: targetTop, left: 0, behavior: 'smooth' });
    } catch {
      window.scrollTo(0, targetTop);
    }
  }

  ngAfterViewInit() {
    this.updateArrows();
    const el = this.scrollerEl()?.nativeElement;
    if (el) {
      this.resizeObserver = new ResizeObserver(() => this.updateArrows());
      this.resizeObserver.observe(el);
    }
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }

  updateArrows() {
    const el = this.scrollerEl()?.nativeElement;
    if (!el) return;
    this.atStart.set(el.scrollLeft <= 0);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  scrollLeft() {
    const el = this.scrollerEl()?.nativeElement;
    if (el) el.scrollBy({ left: -el.clientWidth * 0.8, behavior: 'smooth' });
  }

  scrollRight() {
    const el = this.scrollerEl()?.nativeElement;
    if (el) el.scrollBy({ left: el.clientWidth * 0.8, behavior: 'smooth' });
  }
}
