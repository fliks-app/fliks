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

@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <!-- Backdrop -->
      <div
        [class]="'fixed inset-0 z-[100] transition-opacity duration-200 ' + (showBackdrop() ? 'bg-black/60' : '')"
        [class.opacity-0]="entering() || dismissing()"
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
  /** True for the first 1-2 frames after open() flips, so the backdrop
   *  starts at opacity-0 and transitions to bg-black/60 instead of
   *  appearing instantly. */
  readonly entering = signal(false);

  private startY = 0;
  private startScroll = 0;
  private prevBodyOverflow: string | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect(() => {
      if (this.open()) {
        this.dismissing.set(false);
        this.dragOffset.set(0);
        // Render with opacity-0 first, then flip on the next frame so the
        // CSS transition fires. Two RAFs because Angular schedules a CD
        // tick between them — without the second, the class change can be
        // batched with the initial render and the transition is skipped.
        this.entering.set(true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => this.entering.set(false)),
        );
        // Lock the page scroll behind the sheet. Save+restore the previous
        // inline overflow so we don't trample a parent component's setting.
        if (typeof document !== 'undefined') {
          this.prevBodyOverflow = document.body.style.overflow;
          document.body.style.overflow = 'hidden';
        }
      } else if (this.prevBodyOverflow !== null) {
        if (typeof document !== 'undefined') {
          document.body.style.overflow = this.prevBodyOverflow;
        }
        this.prevBodyOverflow = null;
      }
    });

    // Belt: ensure scroll is unlocked even if the component is destroyed
    // while still open (route change, navigation, etc.).
    destroyRef.onDestroy(() => {
      if (this.prevBodyOverflow !== null && typeof document !== 'undefined') {
        document.body.style.overflow = this.prevBodyOverflow;
        this.prevBodyOverflow = null;
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
