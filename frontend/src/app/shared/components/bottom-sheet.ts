import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  ElementRef,
  viewChild,
  effect,
} from '@angular/core';

@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <!-- Backdrop -->
      <div
        class="fixed inset-0 z-[100] bg-black/60 transition-opacity"
        [class.opacity-0]="dismissing()"
        (click)="dismiss()"
      ></div>
      <!-- Sheet -->
      <div
        #sheet
        class="fixed bottom-0 z-[101] bg-neutral/95 backdrop-blur-xl rounded-t-2xl shadow-2xl max-h-[70vh] overflow-y-auto portrait:left-1 portrait:right-1 landscape:left-2 landscape:right-2 landscape:rounded-2xl landscape:bottom-1"
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
  readonly closed = output<void>();

  readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');
  readonly dragging = signal(false);
  readonly dismissing = signal(false);
  readonly dragOffset = signal(0);

  private startY = 0;
  private startScroll = 0;

  constructor() {
    // Reset state when sheet opens
    effect(() => {
      if (this.open()) {
        this.dismissing.set(false);
        this.dragOffset.set(0);
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
