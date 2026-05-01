import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  ElementRef,
  viewChild,
  effect,
  DestroyRef,
  inject,
} from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { TvService } from '../../core/services/tv.service';

@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <!-- Backdrop — CSS @starting-style handles the fade-in declaratively
           (browser interpolates from opacity 0 on element creation), so the
           component does not need a JS-side toggling pattern. -->
      <div
        [class]="'bottom-sheet-backdrop fixed inset-0 z-[100] transition-opacity duration-200 ' + (showBackdrop() ? 'bg-black/60' : '')"
        [class.opacity-0]="dismissing()"
        (click)="dismiss()"
      ></div>
      <!-- Sheet -->
      <div
        #sheet
        [class]="'fixed bottom-0 z-[101] bg-neutral/95 backdrop-blur-xl rounded-t-2xl shadow-2xl max-h-[70vh] overflow-y-auto portrait:left-1 portrait:right-1 landscape:right-2 landscape:w-[28rem] landscape:max-w-md landscape:rounded-2xl landscape:bottom-1 ' + (rightAligned() ? 'landscape:left-auto' : 'landscape:left-2 landscape:mx-auto')"
        [class.animate-slide-up]="!dismissing()"
        [style.transform]="sheetTransform()"
        [style.transition]="dragging() ? 'none' : 'transform 0.25s ease-out'"
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

  private readonly dismissStack = inject(DismissableStackService);
  private readonly tv = inject(TvService);
  private readonly dismissCallback = () => this.dismiss();
  private startY = 0;
  private startScroll = 0;
  private prevBodyOverflow: string | null = null;
  private prevHtmlOverflow: string | null = null;
  private registered = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect(() => {
      if (this.open()) {
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
      } else {
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
      }
    });

    // Belt: ensure scroll is unlocked + stack is clean even if the component
    // is destroyed while still open (route change, navigation, etc.).
    destroyRef.onDestroy(() => {
      if (this.prevBodyOverflow !== null && typeof document !== 'undefined') {
        document.body.style.overflow = this.prevBodyOverflow;
        document.documentElement.style.overflow = this.prevHtmlOverflow ?? '';
        this.prevBodyOverflow = null;
        this.prevHtmlOverflow = null;
      }
      if (this.registered) {
        this.dismissStack.remove(this.dismissCallback);
        this.registered = false;
      }
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
    this.startScroll = el.scrollTop;
  }

  onTouchMove(e: TouchEvent) {
    const el = this.sheet()?.nativeElement;
    if (!el) return;
    const deltaY = e.touches[0].clientY - this.startY;

    // Only start dragging down when scrolled to top
    if (el.scrollTop <= 0 && deltaY > 0) {
      e.preventDefault();
      this.dragging.set(true);
      this.dragOffset.set(Math.max(0, deltaY - this.startScroll));
    } else if (this.dragging() && deltaY <= 0) {
      // User reversed direction — cancel drag
      this.dragging.set(false);
      this.dragOffset.set(0);
    }
  }

  onTouchEnd() {
    if (!this.dragging()) return;
    this.dragging.set(false);

    // If dragged more than 80px, dismiss; otherwise snap back
    if (this.dragOffset() > 80) {
      this.dismiss();
    } else {
      this.dragOffset.set(0);
    }
  }

  dismiss() {
    this.dismissing.set(true);
    this.dragOffset.set(0);
    setTimeout(() => this.closed.emit(), 250);
  }
}
