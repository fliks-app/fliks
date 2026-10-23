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
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvService } from '../../core/services/tv.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { NavbarService } from '../../core/services/navbar.service';
import { rowTopOffset, snapRowOnFocus } from '../../core/utils/focus-snap.util';
import { RAIL_RESTORED_ATTR } from '../utils/center-rail';

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
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly title = input('');
  readonly atStart = signal(true);
  readonly atEnd = signal(false);
  /** Arrows show only within {@link EDGE_ZONE_PX} of an edge, so they don't cover the middle cards. */
  readonly showLeft = signal(false);
  readonly showRight = signal(false);
  private static readonly EDGE_ZONE_PX = 80;

  private readonly scrollerEl = viewChild<ElementRef<HTMLElement>>('scroller');
  private resizeObserver?: ResizeObserver;
  /** Offset per page: a detached subtree loses its scroll, and one instance can span pages (an episode page across its param). */
  private readonly parked = new Map<string, number>();

  @HostListener('focusin', ['$event'])
  protected onFocusIn(event: FocusEvent): void {
    snapRowOnFocus(event, this.host.nativeElement, rowTopOffset(this.tv.isTv()));
  }

  ngAfterViewInit() {
    // The observer's first callback lands after layout; a read here would force one.
    const el = this.scrollerEl()?.nativeElement;
    if (el) {
      this.resizeObserver = new ResizeObserver(() => this.updateArrows());
      this.resizeObserver.observe(el);
    }
    // Reuse routes reattach this row without re-running ngAfterViewInit, resetting scrollLeft and leaving atStart/atEnd stale; recompute next frame.
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
    // A page keeping its instance across a param change is never detached, so `attached$` is silent; the navigation is the only signal.
    this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e instanceof NavigationStart) {
        this.scrollerEl()?.nativeElement.removeAttribute(RAIL_RESTORED_ATTR);
      }
      if (e instanceof NavigationEnd) this.restoreScroll();
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
    this.parked.set(this.pageKey(), el.scrollLeft);
    this.atStart.set(el.scrollLeft <= 0);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  /** Read off the document, not the router, whose url is rewritten first on navigation; query strings are in-page state, so the path names the page. */
  private pageKey(): string {
    return location.pathname;
  }

  /** `scrollTo` since the rail's `scroll-behavior: smooth` would glide the property write. Only on a return: opening a page is a fresh screen at zero. */
  private restoreScroll() {
    const el = this.scrollerEl()?.nativeElement;
    if (!el || !el.isConnected || !this.navbar.navigatedBack()) return;
    const parked = this.parked.get(this.pageKey());
    if (!parked) return;
    el.scrollTo({ left: parked, behavior: 'instant' });
    el.setAttribute(RAIL_RESTORED_ATTR, '');
  }

  scrollLeft() {
    const el = this.scrollerEl()?.nativeElement;
    if (el) el.scrollBy({ left: -el.clientWidth * 0.8, behavior: 'smooth' });
  }

  scrollRight() {
    const el = this.scrollerEl()?.nativeElement;
    if (el) el.scrollBy({ left: el.clientWidth * 0.8, behavior: 'smooth' });
  }

  /** Signals are written only on change so high-frequency mousemove doesn't thrash change detection. */
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
