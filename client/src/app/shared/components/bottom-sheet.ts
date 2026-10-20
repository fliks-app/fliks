import {
  Component,
  input,
  output,
  signal,
  ElementRef,
  viewChild,
  effect,
  untracked,
  DestroyRef,
  Injector,
  afterNextRender,
  inject,
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

@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  // The backdrop and sheet are `position: fixed`, so the host needs no box (as in `app-popover-menu`); a box becomes a stray grid item in `.modal`.
  styles: [':host { display: contents; }'],
  templateUrl: './bottom-sheet.html',
})
export class BottomSheetComponent {
  readonly open = input(false);
  /** Optional label shown above the content, sheet-only by construction. */
  readonly heading = input('');
  readonly showBackdrop = input(true);
  readonly rightAligned = input(false);
  readonly closed = output<void>();

  readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');
  readonly dragging = signal(false);
  readonly dismissing = signal(false);
  readonly dragOffset = signal(0);
  /** Drives the DOM `@if`, decoupled from `open` so the sheet can play its
   *  slide-down exit before it is removed. */
  readonly visible = signal(false);
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly dismissStack = inject(DismissableStackService);
  private readonly tv = inject(TvService);
  private readonly injector = inject(Injector);
  private readonly dismissCallback = () => this.dismiss();
  private startY = 0;
  /** True when the touch began with the sheet scrolled to the top; only then can a downward drag dismiss, so a scroll never chains into the close. */
  private startedAtTop = false;
  /** A drag from the handle/title always dismisses: it sits above the list, so
   *  it never scrolls it, however far the list is scrolled. */
  private fromHandle = false;
  /** Y of the previous touchmove and the last move's direction; release dismisses only if still heading down. */
  private prevY = 0;
  private movingDown = true;
  private prevBodyOverflow: string | null = null;
  private prevHtmlOverflow: string | null = null;
  private registered = false;
  private focusTrapActive = false;
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
          this.dismissing.set(false);
          this.dragOffset.set(0);
          // Lock page scroll, saving the prior inline overflow; TV scrolls on html (body is scaled), elsewhere locking html shifts the pinned drawer.
          if (typeof document !== 'undefined') {
            this.prevBodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            if (this.tv.isTv()) {
              this.prevHtmlOverflow = document.documentElement.style.overflow;
              document.documentElement.style.overflow = 'hidden';
            }
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

    // Cleanup if destroyed while open (route change, parent `@if`; PopoverMenu hardcodes `[open]="true"`, so the effect's close branch never runs).
    destroyRef.onDestroy(() => {
      if (this.exitTimer) {
        clearTimeout(this.exitTimer);
        this.exitTimer = null;
      }
      this.releaseOpenState();
    });
  }

  sheetTransform(): string {
    if (this.dismissing()) return 'translateY(100%)';
    const offset = this.dragOffset();
    return offset > 0 ? `translateY(${offset}px)` : '';
  }

  onTouchStart(e: TouchEvent) {
    const el = this.sheet()?.nativeElement;
    if (!el) return;
    this.startY = e.touches[0].clientY;
    this.prevY = this.startY;
    this.movingDown = true;
    this.startedAtTop = !scrolledBetween(e.target, el);
    this.fromHandle = e.target instanceof Element && !!e.target.closest('[data-sheet-handle]');
  }

  onTouchMove(e: TouchEvent) {
    const el = this.sheet()?.nativeElement;
    if (!el) return;
    const y = e.touches[0].clientY;
    const deltaY = y - this.startY;

    // Only a pull that began at the top becomes a dismiss-drag; scrolling up to the top must not chain into the close.
    const canDrag = this.fromHandle || (this.startedAtTop && !scrolledBetween(e.target, el));
    if (canDrag && deltaY > 0) {
      e.preventDefault();
      this.dragging.set(true);
      this.dragOffset.set(deltaY);
      // Remember the last meaningful direction (2px deadzone ignores jitter),
      // so the release can tell an eased-back pull from a committed swipe.
      const dy = y - this.prevY;
      if (Math.abs(dy) >= 2) this.movingDown = dy > 0;
    } else if (this.dragging() && deltaY <= 0) {
      // User reversed all the way past the start — cancel drag
      this.dragging.set(false);
      this.dragOffset.set(0);
    }
    this.prevY = y;
  }

  onTouchEnd() {
    if (!this.dragging()) return;
    this.dragging.set(false);

    // Dismiss only when pulled past the threshold AND still heading down at
    // release — easing back up after over-pulling snaps the sheet open again.
    if (this.dragOffset() > 80 && this.movingDown) {
      this.dismiss();
    } else {
      this.dragOffset.set(0);
    }
  }

  dismiss() {
    this.beginClose();
  }

  /** Slides the sheet down, then removes it and notifies the parent; idempotent, and every close path funnels here. */
  private beginClose() {
    if (this.exitTimer || !this.visible()) return;
    this.releaseOpenState();
    this.dismissing.set(true);
    this.dragOffset.set(0);
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      this.visible.set(false);
      this.dismissing.set(false);
      this.closed.emit();
    }, 180);
  }

  /** Undo the open-time side effects: restore page scroll, leave the dismiss
   *  stack, and (TV) drop the focus trap and restore the trigger's focus. */
  private releaseOpenState() {
    if (this.prevBodyOverflow !== null) {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = this.prevBodyOverflow;
        document.documentElement.style.overflow = this.prevHtmlOverflow ?? '';
      }
      this.prevBodyOverflow = null;
      this.prevHtmlOverflow = null;
    }
    if (this.registered) {
      this.dismissStack.remove(this.dismissCallback);
      this.registered = false;
    }
    if (this.focusTrapActive && typeof document !== 'undefined') {
      document.removeEventListener('focusin', this.onFocusIn);
      this.focusTrapActive = false;
      restoreOpenerFocus(this.prevFocused);
      this.prevFocused = null;
    }
  }
}

/** Whether anything from the touched element up to the sheet is scrolled away
 *  from its top: content may scroll in an inner box (a list under a sticky title). */
export function scrolledBetween(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let n = target instanceof Element ? target : null; n; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
    if (n === sheet) return false;
  }
  return false;
}
