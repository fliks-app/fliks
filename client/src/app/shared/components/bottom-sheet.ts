import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  input,
  output,
  signal,
  computed,
  ElementRef,
  viewChild,
  effect,
  untracked,
  DestroyRef,
  Injector,
  afterNextRender,
  inject,
  model,
} from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { TvService } from '../../core/services/tv.service';
import {
  TABBABLE_SELECTOR,
  focusOverlayEntry,
  initialOverlayFocus,
  restoreOpenerFocus,
  scrollSelectedIntoView,
} from '../../core/services/focusable.constants';
import { SheetDrag, sheetDurationMs } from './sheet-drag';

/** The phone dock's own surface, so a sheet resting on it reads as one piece. */
const DOCK_BG = 'bg-base-100/80 backdrop-blur-sm reduced-effects:bg-base-100/95';

@Component({
  selector: 'app-bottom-sheet',
  // The backdrop and sheet are `position: fixed`, so the host needs no box (as in `app-popover-menu`); a box becomes a stray grid item in `.modal`.
  styles: [':host { display: contents; }'],
  imports: [NgTemplateOutlet],
  templateUrl: './bottom-sheet.html',
})
export class BottomSheetComponent {
  readonly open = input(false);
  /** Optional label shown above the content, sheet-only by construction. */
  readonly heading = input('');
  readonly showBackdrop = input(true);
  readonly rightAligned = input(false);
  /** Covers the whole viewport instead of the usual bottom card: a full page that slides up and is dismissed by dragging it down. */
  readonly fullHeight = input(false);
  /** Leaves the phone dock uncovered: the sheet rests on it and dims only the page above itself. */
  readonly aboveDock = input(false);
  protected readonly layers = computed(() =>
    this.aboveDock()
      ? { backdrop: 'z-[38]', sheet: 'z-[39]', bg: DOCK_BG, handleBg: 'bg-transparent' }
      : this.fullHeight()
        ? { backdrop: 'z-[94]', sheet: 'z-[95]', bg: 'bg-base-100', handleBg: 'bg-base-100' }
        : { backdrop: 'z-[100]', sheet: 'z-[101]', bg: 'bg-neutral', handleBg: 'bg-neutral' },
  );
  readonly closed = output<void>();

  readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');
  private readonly drag = new SheetDrag();
  readonly dragging = this.drag.dragging;
  readonly dismissing = signal(false);
  readonly dragOffset = this.drag.offset;
  /** Drives the DOM `@if`, decoupled from `open` so the sheet can play its
   *  slide-down exit before it is removed. */
  readonly visible = signal(false);
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The sheet rests still on the dock: its surface may run on under it. Down while it slides in, is dragged or leaves. */
  readonly settled = model(false);
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly dismissStack = inject(DismissableStackService);
  private readonly tv = inject(TvService);
  private readonly injector = inject(Injector);
  private readonly dismissCallback = () => this.dismiss();
  private scrollLocked = false;
  private registered = false;
  private focusTrapActive = false;
  private coversPage = false;
  /** Element focused when the sheet opened — restored on close. */
  private prevFocused: HTMLElement | null = null;

  /** TV-only focus trap: at the last item, spatial nav targets the background and the browser scrolls it into view even with `overflow: hidden`.
   *  Bouncing `focusin` back inside prevents that. */
  private readonly onFocusIn = (e: FocusEvent) => {
    const sheetEl = this.sheet()?.nativeElement;
    if (!sheetEl) return;
    const target = e.target as HTMLElement | null;
    if (!target || sheetEl.contains(target)) return;
    const first = sheetEl.querySelector<HTMLElement>(TABBABLE_SELECTOR);
    first?.focus({ preventScroll: true });
  };

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect(() => {
      const isOpen = this.open();
      // `open()` is the only intended dependency; the body reads and writes
      // several other signals, so run it untracked to avoid re-entrancy.
      untracked(() => {
        if (isOpen) {
          if (this.exitTimer) {
            clearTimeout(this.exitTimer);
            this.exitTimer = null;
          }
          this.visible.set(true);
          this.settleAfterSlide();
          this.dismissing.set(false);
          this.drag.reset();
          if (!this.scrollLocked && typeof document !== 'undefined') {
            lockPageScroll(this.tv.isTv());
            this.scrollLocked = true;
          }
          // Register on the dismiss stack so the hardware/gesture back closes
          // this sheet before falling through to the route-level back handler.
          if (!this.registered) {
            this.dismissStack.push(this.dismissCallback);
            this.registered = true;
          }
          // The sheet content only exists after this render; scroll, never focus.
          afterNextRender(() => scrollSelectedIntoView(this.sheet()?.nativeElement), {
            injector: this.injector,
          });
          if (this.tv.isTv() && !this.focusTrapActive && typeof document !== 'undefined') {
            // Snapshot the trigger before the trap can bounce focus; restored on close.
            this.prevFocused = document.activeElement as HTMLElement | null;
            document.addEventListener('focusin', this.onFocusIn);
            this.focusTrapActive = true;
            if (this.fullHeight()) {
              coverPage(true);
              this.coversPage = true;
            }
            // Move focus into the sheet on open, else the D-pad still acts on the background. queueMicrotask, not rAF, so the halo isn't painted on the wrong element.
            queueMicrotask(() => {
              if (!this.open()) return;
              focusOverlayEntry(initialOverlayFocus(this.sheet()?.nativeElement));
            });
          }
        } else {
          // Animate the exit whatever caused the close (item select or dismiss()).
          this.beginClose();
        }
      });
    });

    // A drag lifts the sheet off the dock; a release that keeps it open settles it again once it has slid back.
    effect(() => {
      const dragging = this.dragging();
      untracked(() => {
        if (dragging) this.unsettle();
        else if (this.visible() && !this.exitTimer && !this.settled()) this.settleAfterSlide();
      });
    });

    // Cleanup if destroyed while open (route change, parent `@if`; PopoverMenu hardcodes `[open]="true"`, so the effect's close branch never runs).
    destroyRef.onDestroy(() => {
      this.unsettle();
      if (this.exitTimer) {
        clearTimeout(this.exitTimer);
        this.exitTimer = null;
      }
      this.releaseOpenState();
    });
  }

  private settleAfterSlide() {
    this.unsettle();
    this.settleTimer = setTimeout(() => this.settled.set(true), sheetDurationMs(document.documentElement));
  }

  private unsettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.settled.set(false);
  }

  sheetTransition(): string {
    return this.dragging() ? 'none' : 'transform var(--transition-duration-sheet) ease-out';
  }

  sheetTransform(): string {
    if (this.dismissing()) return 'translateY(100%)';
    const offset = this.dragOffset();
    return offset > 0 ? `translateY(${offset}px)` : '';
  }

  onTouchStart(e: TouchEvent) {
    const el = this.sheet()?.nativeElement;
    if (!el) return;
    this.drag.start(e, el, e.target instanceof Element && !!e.target.closest('[data-sheet-handle]'));
  }

  onTouchMove(e: TouchEvent) {
    const el = this.sheet()?.nativeElement;
    if (el) this.drag.move(e, el);
  }

  onTouchEnd() {
    if (this.drag.end()) this.dismiss();
  }

  dismiss() {
    this.beginClose();
  }

  /** Slides the sheet down, then removes it and notifies the parent; idempotent, and every close path funnels here. */
  private beginClose() {
    if (this.exitTimer || !this.visible()) return;
    this.unsettle();
    this.releaseOpenState();
    this.dismissing.set(true);
    this.drag.reset();
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      this.visible.set(false);
      this.dismissing.set(false);
      this.closed.emit();
    }, sheetDurationMs(document.documentElement));
  }

  /** Undo the open-time side effects: restore page scroll, leave the dismiss
   *  stack, and (TV) drop the focus trap and restore the trigger's focus. */
  private releaseOpenState() {
    if (this.scrollLocked) {
      unlockPageScroll();
      this.scrollLocked = false;
    }
    if (this.registered) {
      this.dismissStack.remove(this.dismissCallback);
      this.registered = false;
    }
    if (this.focusTrapActive && typeof document !== 'undefined') {
      document.removeEventListener('focusin', this.onFocusIn);
      this.focusTrapActive = false;
      if (this.coversPage) {
        coverPage(false);
        this.coversPage = false;
      }
      restoreOpenerFocus(this.prevFocused);
      this.prevFocused = null;
    }
  }
}

/** Shared by every open sheet: nested sheets release out of order (a child torn down after its parent closed), so only the last one restores. */
let scrollLocks = 0;
let savedOverflow: { body: string; html: string } | null = null;

let pageCovers = 0;

/** A full-height sheet is opaque, so the page behind is hidden to spare the TV's GPU; counted for stacked sheets. */
function coverPage(on: boolean): void {
  pageCovers = Math.max(0, pageCovers + (on ? 1 : -1));
  document.documentElement.classList.toggle('sheet-covers', pageCovers > 0);
}

/** TV scrolls on html (body is scaled); elsewhere locking html shifts the pinned drawer. */
function lockPageScroll(tv: boolean): void {
  if (scrollLocks++ > 0) return;
  savedOverflow = { body: document.body.style.overflow, html: document.documentElement.style.overflow };
  document.body.style.overflow = 'hidden';
  if (tv) document.documentElement.style.overflow = 'hidden';
}

function unlockPageScroll(): void {
  if (--scrollLocks > 0 || !savedOverflow) return;
  document.body.style.overflow = savedOverflow.body;
  document.documentElement.style.overflow = savedOverflow.html;
  savedOverflow = null;
}
