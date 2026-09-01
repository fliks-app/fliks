import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  ElementRef,
  viewChild,
  effect,
  untracked,
  DestroyRef,
  inject,
} from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { TvService } from '../../core/services/tv.service';
import {
  TABBABLE_SELECTOR,
  initialOverlayFocus,
  restoreOpenerFocus,
} from '../../core/services/focusable.constants';

@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Same reason as `app-popover-menu`: the backdrop and sheet are
  // `position: fixed`, so the host needs no box — and left with one it becomes
  // a stray grid item in a parent like daisyUI's `.modal` (display: grid),
  // adding a row that pushes the modal-box off-centre and covers the backdrop.
  styles: [':host { display: contents; }'],
  template: `
    @if (visible()) {
      <!-- Backdrop — CSS @starting-style handles the fade-in declaratively
           (browser interpolates from opacity 0 on element creation), so the
           component does not need a JS-side toggling pattern.
           Preventing the pointerdown default keeps the tap from blurring
           whatever opened the sheet: focus used to leave and be restored a tick
           later, which flickered the opener's ring off and back on. -->
      <div
        [class]="
          'bottom-sheet-backdrop fixed inset-0 z-[100] transition-opacity duration-150 ' +
          (showBackdrop() ? 'bg-black/60' : '')
        "
        [class.opacity-0]="dismissing()"
        (pointerdown)="$event.preventDefault()"
        (click)="dismiss()"
      ></div>
      <!-- Sheet -->
      <div
        #sheet
        [class]="
          'fixed bottom-0 z-[101] bg-neutral/95 backdrop-blur-xl rounded-t-2xl shadow-2xl max-h-[70vh] overflow-y-auto portrait:left-1 portrait:right-1 landscape:right-2 landscape:w-[28rem] landscape:max-w-md landscape:rounded-2xl landscape:bottom-1 ' +
          (rightAligned() ? 'landscape:left-auto' : 'landscape:left-2 landscape:mx-auto')
        "
        [class.animate-slide-up]="!dismissing()"
        [style.transform]="sheetTransform()"
        [style.transition]="dragging() ? 'none' : 'transform 0.18s ease-out'"
        [style.padding-bottom]="'env(safe-area-inset-bottom)'"
        (touchstart)="onTouchStart($event)"
        (touchmove)="onTouchMove($event)"
        (touchend)="onTouchEnd()"
      >
        <!-- Drag handle -->
        <div class="flex justify-center pt-3 pb-1 cursor-grab">
          <div class="w-10 h-1 rounded-full bg-white/20"></div>
        </div>
        <!-- Content -->
        <ng-content></ng-content>
      </div>
    }
  `,
})
export class BottomSheetComponent {
  readonly open = input(false);
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
  private readonly dismissCallback = () => this.dismiss();
  private startY = 0;
  /** True when the touch gesture began with the sheet already scrolled to the
   *  top. Only then can a downward drag turn into a dismiss — otherwise
   *  scrolling a long list up to the top and continuing in the same gesture
   *  would chain straight into the close. Reaching the top mid-scroll stops;
   *  a fresh swipe (new touchstart at the top) is needed to dismiss. */
  private startedAtTop = false;
  /** Y of the previous touchmove, and whether the last meaningful move went
   *  downward — the release only dismisses when the finger was still heading
   *  down, so easing back up after over-pulling keeps the sheet open. */
  private prevY = 0;
  private movingDown = true;
  private prevBodyOverflow: string | null = null;
  private prevHtmlOverflow: string | null = null;
  private registered = false;
  private focusTrapActive = false;
  /** Element focused when the sheet opened — restored on close. */
  private prevFocused: HTMLElement | null = null;

  /**
   * TV-only focus trap. The WebView's spatial navigation moves focus to the
   * visually closest focusable on D-pad press; once the user reaches the
   * sheet's last item, ↓ targets an element on the background and the
   * browser auto-`scrollIntoView`s the background into the visible region
   * — even with `overflow: hidden` on body/html (programmatic scroll is
   * not blocked). Catching `focusin` and bouncing focus back inside
   * neutralises that path.
   */
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
          // Lock the page scroll behind the sheet. Save+restore the previous
          // inline overflow so we don't trample a parent component's setting.
          // On TV body has a scale transform that makes html the scrolling
          // element — lock both. On other form factors body is the scroller
          // and locking html on tablet landscape (pinned drawer) shifts the
          // sidebar upward.
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
          if (this.tv.isTv() && !this.focusTrapActive && typeof document !== 'undefined') {
            // Snapshot the trigger before the trap can bounce focus inside.
            // Restored on close so the user lands back on the element they
            // pressed (e.g. a <select appTvSelect>) — not on the option they
            // happened to highlight last in the sheet.
            this.prevFocused = document.activeElement as HTMLElement | null;
            document.addEventListener('focusin', this.onFocusIn);
            this.focusTrapActive = true;
            // Move focus inside the sheet on open. Without this, the D-pad
            // still operates on the trigger row (or the previously-focused
            // tile in the route), so up/down moves to a background element and
            // the focus-trap fires AFTER the user has already left the sheet
            // visually — feels unresponsive.
            // queueMicrotask waits until @if has materialised the sheet
            // content; rAF would defer one extra frame and let the WebView
            // paint the focus halo on the wrong element first.
            queueMicrotask(() => {
              if (!this.open()) return;
              initialOverlayFocus(this.sheet()?.nativeElement)?.focus({
                preventScroll: true,
              });
            });
          }
        } else {
          // Animate the slide-down exit instead of an instant teardown, whatever
          // caused the close (item select flipping `open`, or backdrop/drag/back
          // via dismiss()).
          this.beginClose();
        }
      });
    });

    // Belt: ensure scroll is unlocked, the stack is clean, the exit timer is
    // cleared, and (TV) focus is restored even if the component is destroyed
    // while still open — e.g. a route change, or a parent `@if` tearing the
    // sheet down (PopoverMenu hardcodes `[open]="true"`, so the effect's close
    // branch never runs for that path).
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
    this.startedAtTop = el.scrollTop <= 0;
  }

  onTouchMove(e: TouchEvent) {
    const el = this.sheet()?.nativeElement;
    if (!el) return;
    const y = e.touches[0].clientY;
    const deltaY = y - this.startY;

    // Only turn a downward pull into a dismiss-drag when the gesture began at
    // the top. Scrolling a long list up to the top does NOT chain into the
    // close in the same gesture — the user lifts and swipes again.
    if (this.startedAtTop && el.scrollTop <= 0 && deltaY > 0) {
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

  /** Slide the sheet down, then remove it from the DOM and notify the parent.
   *  Idempotent — a close already in flight is not restarted. Every close path
   *  funnels through here so selecting an item animates out exactly like a
   *  backdrop tap or a drag-down. */
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
