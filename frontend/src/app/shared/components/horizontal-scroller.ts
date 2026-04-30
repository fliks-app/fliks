import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  signal,
  viewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';
import { TvService } from '../../core/services/tv.service';

@Component({
  selector: 'app-horizontal-scroller',
  imports: [LucideChevronLeft, LucideChevronRight],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Header: title + arrows (arrows are mouse-only — hidden on touch/TV) -->
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-lg font-bold">{{ title() }}</h2>
      <div class="flex gap-1 scroll-arrows">
        <button
          class="btn btn-ghost btn-sm btn-circle"
          [disabled]="atStart()"
          (click)="scrollLeft()"
        >
          <svg lucideChevronLeft class="h-5 w-5"></svg>
        </button>
        <button
          class="btn btn-ghost btn-sm btn-circle"
          [disabled]="atEnd()"
          (click)="scrollRight()"
        >
          <svg lucideChevronRight class="h-5 w-5"></svg>
        </button>
      </div>
    </div>
    <!-- Scrollable content (no visible scrollbar). On TV the scroller gets
         vertical padding (and a matching negative margin so neighbours don't
         shift) to make room for the focus ring + media-card scale-up — both
         extend past the row and would otherwise be clipped by overflow-y. -->
    <div
      #scroller
      class="flex gap-3 overflow-x-auto scrollbar-none"
      [class.py-3]="tv.isTv()"
      [class.-my-3]="tv.isTv()"
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
  protected readonly tv = inject(TvService);
  readonly title = input('');
  readonly atStart = signal(true);
  readonly atEnd = signal(false);

  private readonly scrollerEl = viewChild<ElementRef<HTMLElement>>('scroller');
  private resizeObserver?: ResizeObserver;

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
