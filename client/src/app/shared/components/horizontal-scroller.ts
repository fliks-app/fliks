import {
  afterNextRender,
  Component,
  computed,
  contentChild,
  DestroyRef,
  HostListener,
  inject,
  input,
  linkedSignal,
  signal,
  TemplateRef,
  viewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';
import { TvRowDirective } from '../directives/tv-row.directive';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { NavbarService } from '../../core/services/navbar.service';
import { ROW_TOP_OFFSET, snapRowOnFocus } from '../../core/utils/focus-snap.util';
import { RAIL_RESTORED_ATTR } from '../utils/center-rail';

/** Cards built before the rail is measured: a tablet-wide row of episode cards; the next ones come with its first layout. */
const FIRST_PASS = 5;
/** Cards built past the right edge, so a D-pad or Tab step always lands on a built card. */
const OVERSCAN = 3;

/** The number of cards to build: past the anchor and past the right edge, never fewer than already built. */
export function builtCount(total: number, built: number, anchor: number | null, lastVisible: number | null): number {
  let n = Math.max(built, FIRST_PASS);
  if (anchor != null && anchor >= 0) n = Math.max(n, anchor + 1 + OVERSCAN);
  if (lastVisible != null) n = Math.max(n, lastVisible + 1 + OVERSCAN);
  return Math.min(n, total);
}

@Component({
  selector: 'app-horizontal-scroller',
  imports: [TvRowDirective, LucideDynamicIcon, NgTemplateOutlet],
  templateUrl: './horizontal-scroller.html',
  styleUrl: './horizontal-scroller.css',
})
export class HorizontalScrollerComponent<T = unknown> implements AfterViewInit, OnDestroy {
  protected readonly icons = icons;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reuse = inject(CachingReuseStrategy);
  private readonly navbar = inject(NavbarService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly title = input('');
  /** With items, cards are built from the projected `<ng-template let-item>` as the rail nears them; built ones stay. */
  readonly items = input<readonly T[] | null>(null);
  readonly trackBy = input<(item: T) => unknown>((item) => item);
  /** Index built from the first pass, for a rail centred on it. */
  readonly anchorIndex = input<number | null>(null);
  protected readonly itemTemplate = contentChild<TemplateRef<{ $implicit: T; index: number }>>(TemplateRef);
  private readonly built = linkedSignal<{ items: readonly T[] | null; anchor: number | null }, number>({
    source: () => ({ items: this.items(), anchor: this.anchorIndex() }),
    computation: (src, prev) =>
      builtCount(src.items?.length ?? 0, prev?.source.items === src.items ? prev.value : 0, src.anchor, null),
  });
  protected readonly builtItems = computed(() => this.items()?.slice(0, this.built()) ?? []);
  /** Card pitch and gap, read once laid out; the tail spacer keeps the rail as wide as if every card were built. */
  private readonly stride = signal(0);
  private gapPx = 0;
  private firstLeft = 0;
  protected readonly tailPx = computed(() => {
    const rest = (this.items()?.length ?? 0) - this.built();
    return rest > 0 && this.stride() > 0 ? rest * this.stride() - this.gapPx : 0;
  });
  readonly atStart = signal(true);
  readonly atEnd = signal(false);
  /** Arrows show only within {@link EDGE_ZONE_PX} of an edge, so they don't cover the middle cards. */
  readonly showLeft = signal(false);
  readonly showRight = signal(false);
  private static readonly EDGE_ZONE_PX = 80;

  private readonly scrollerEl = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly wrapEl = viewChild<ElementRef<HTMLElement>>('wrap');
  /** Read once per hover: a layout read per mousemove would cost more than the arrows it drives. */
  private wrapRect: DOMRect | null = null;
  private resizeObserver?: ResizeObserver;
  /** Offset per page: a detached subtree loses its scroll, and one instance can span pages (an episode page across its param). */
  private readonly parked = new Map<string, number>();

  constructor() {
    // Plain passive listeners: a template binding would run change detection on every scroll and mousemove.
    afterNextRender(() => {
      const scroller = this.scrollerEl()?.nativeElement;
      const wrap = this.wrapEl()?.nativeElement;
      if (!scroller || !wrap) return;
      const onScroll = () => {
        this.updateArrows();
        this.grow(scroller);
      };
      const onMove = (e: MouseEvent) => this.onPointerMove(e);
      const onLeave = () => this.onPointerLeave();
      scroller.addEventListener('scroll', onScroll, { passive: true });
      wrap.addEventListener('mousemove', onMove, { passive: true });
      wrap.addEventListener('mouseleave', onLeave, { passive: true });
      this.destroyRef.onDestroy(() => {
        scroller.removeEventListener('scroll', onScroll);
        wrap.removeEventListener('mousemove', onMove);
        wrap.removeEventListener('mouseleave', onLeave);
      });
    });
  }

  @HostListener('focusin', ['$event'])
  protected onFocusIn(event: FocusEvent): void {
    snapRowOnFocus(event, this.host.nativeElement, ROW_TOP_OFFSET);
  }

  ngAfterViewInit() {
    // The observer's first callback lands after layout; a read here would force one.
    const el = this.scrollerEl()?.nativeElement;
    if (el) {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateArrows();
        this.grow(el);
      });
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

  /** Builds the cards the viewport is about to show; reads layout only from scroll and resize callbacks, where it is clean. */
  private grow(el: HTMLElement) {
    const total = this.items()?.length ?? 0;
    if (!total || !el.isConnected) return;
    if (!this.stride()) {
      const [a, b] = el.querySelectorAll<HTMLElement>(':scope > :not([data-spacer])');
      if (!a || !b) return;
      this.firstLeft = a.offsetLeft;
      this.gapPx = parseFloat(getComputedStyle(el).columnGap) || 0;
      this.stride.set(b.offsetLeft - a.offsetLeft);
    }
    const lastVisible = Math.floor((el.scrollLeft + el.clientWidth - this.firstLeft) / this.stride());
    const next = builtCount(total, this.built(), this.anchorIndex(), lastVisible);
    if (next > this.built()) this.built.set(next);
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
    const rect = (this.wrapRect ??= (event.currentTarget as HTMLElement).getBoundingClientRect());
    const x = event.clientX - rect.left;
    const zone = HorizontalScrollerComponent.EDGE_ZONE_PX;
    const left = x <= zone;
    const right = x >= rect.width - zone;
    if (this.showLeft() !== left) this.showLeft.set(left);
    if (this.showRight() !== right) this.showRight.set(right);
  }

  onPointerLeave() {
    this.wrapRect = null;
    if (this.showLeft()) this.showLeft.set(false);
    if (this.showRight()) this.showRight.set(false);
  }
}
