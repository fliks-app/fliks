import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  HostListener,
  inject,
  input,
  signal,
  viewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvService } from '../../core/services/tv.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';

@Component({
  selector: 'app-horizontal-scroller',
  imports: [LucideChevronLeft, LucideChevronRight, TvRowDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './horizontal-scroller.html',
  styleUrl: './horizontal-scroller.css',
})
export class HorizontalScrollerComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tv = inject(TvService);
  private readonly reuse = inject(CachingReuseStrategy);
  private readonly destroyRef = inject(DestroyRef);
  readonly title = input('');
  readonly atStart = signal(true);
  readonly atEnd = signal(false);
  /** Edge arrows reveal only while the cursor sits within {@link EDGE_ZONE_PX}
   *  of that edge, not on a whole-row hover — so they don't cover the middle
   *  cards and only show where they act. */
  readonly showLeft = signal(false);
  readonly showRight = signal(false);
  private static readonly EDGE_ZONE_PX = 80;

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
    // Clicking a card focuses it too, and pulling the page under the cursor
    // mid-click is never wanted. Chromium 76 (Tizen) throws on the selector —
    // those builds are D-pad only, where every focus deserves the snap.
    try {
      const target = event.target as HTMLElement | null;
      if (target && !target.matches(':focus-visible')) return;
    } catch {
      // No :focus-visible support — fall through and snap.
    }
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
    // Routes flagged `reuse: true` detach this row's DOM on navigate-away and
    // reattach it on return without re-running ngAfterViewInit. The reattach
    // can reset the rail's scrollLeft and leaves atStart/atEnd stale, so the
    // arrows show the wrong state coming back from a detail page. Recompute
    // once the page is reattached (next frame, after layout settles).
    this.reuse.attached$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // The cursor isn't necessarily over the row on return — drop any
        // stale proximity state, then recompute the scroll extents.
        this.showLeft.set(false);
        this.showRight.set(false);
        requestAnimationFrame(() => this.updateArrows());
      });
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

  /** Reveal an edge arrow only when the cursor is within the edge zone on
   *  that side. Signals are written only on change so the high-frequency
   *  mousemove doesn't thrash change detection. */
  onPointerMove(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const zone = HorizontalScrollerComponent.EDGE_ZONE_PX;
    const left = x <= zone;
    const right = x >= rect.width - zone;
    if (this.showLeft() !== left) this.showLeft.set(left);
    if (this.showRight() !== right) this.showRight.set(right);
  }

  onPointerLeave() {
    if (this.showLeft()) this.showLeft.set(false);
    if (this.showRight()) this.showRight.set(false);
  }
}
