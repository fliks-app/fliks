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
  /** Edge arrows reveal only while the cursor sits within {@link EDGE_ZONE_PX}
   *  of that edge, not on a whole-row hover — so they don't cover the middle
   *  cards and only show where they act. */
  readonly showLeft = signal(false);
  readonly showRight = signal(false);
  private static readonly EDGE_ZONE_PX = 80;

  private readonly scrollerEl = viewChild<ElementRef<HTMLElement>>('scroller');
  private resizeObserver?: ResizeObserver;
  /** Last offset each page left this row at. A detached subtree loses its
   *  scroll and the instance outlives the detach, so the instance is the store
   *  — but one instance can span several pages, an episode page keeping it
   *  across the param that names the episode, so it is one offset per page
   *  rather than one for the row. */
  private readonly parked = new Map<string, number>();

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
    // A page that keeps its instance across a param change — one episode over
    // another — is never detached, so `attached$` says nothing about the trip
    // back to it. The navigation itself is the only signal left.
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

  /** The page this row's offset is filed under. Read off the document rather
   *  than the router: a scroll event lands a task after the one that moved the
   *  rail, and the router's own url is the first thing a navigation rewrites.
   *  Query strings are in-page state (a library's tabs and filters), which the
   *  row scrolls within, so the path alone names the page. */
  private pageKey(): string {
    return location.pathname;
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
