import {
  Component,
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
import { NavbarService } from '../../core/services/navbar.service';
import { rowTopOffset, snapRowOnFocus } from '../../core/utils/focus-snap.util';

@Component({
  selector: 'app-horizontal-scroller',
  imports: [LucideChevronLeft, LucideChevronRight, TvRowDirective],
  templateUrl: './horizontal-scroller.html',
  styleUrl: './horizontal-scroller.css',
})
export class HorizontalScrollerComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tv = inject(TvService);
  private readonly reuse = inject(CachingReuseStrategy);
  private readonly navbar = inject(NavbarService);
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
  /** Last offset the row was left at. A detached subtree loses its scroll, and
   *  the instance outlives the detach, so the field is the whole store. */
  private parkedScrollLeft = 0;

  @HostListener('focusin', ['$event'])
  protected onFocusIn(event: FocusEvent): void {
    snapRowOnFocus(event, this.host.nativeElement, rowTopOffset(this.tv.isTv()));
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
        // Synchronously, before the frame that would dispatch the reset's own
        // scroll event and overwrite the parked offset.
        this.restoreScroll();
        requestAnimationFrame(() => {
          // Again once laid out: a rail whose extents weren't known yet clamped
          // the first attempt.
          this.restoreScroll();
          this.updateArrows();
        });
      });
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }

  updateArrows() {
    const el = this.scrollerEl()?.nativeElement;
    // attached$ is not route-scoped, so rails of pages still held by the reuse
    // cache get here too — reading their extents is a forced layout for nothing.
    if (!el || !el.isConnected) return;
    this.parkedScrollLeft = el.scrollLeft;
    this.atStart.set(el.scrollLeft <= 0);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  /** `scrollTo`, not the property: the rail carries `scroll-behavior: smooth`,
   *  which would turn a restore into a visible glide.
   *
   *  Only on a return. Opening the page is a fresh screen, and the reattach
   *  already left the rail at zero — the parked offset is then overwritten by
   *  the `updateArrows()` that follows, so the next return restores what the
   *  user actually left. */
  private restoreScroll() {
    const el = this.scrollerEl()?.nativeElement;
    if (!el || !el.isConnected || !this.parkedScrollLeft) return;
    if (!this.navbar.navigatedBack()) return;
    el.scrollTo({ left: this.parkedScrollLeft, behavior: 'instant' });
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
